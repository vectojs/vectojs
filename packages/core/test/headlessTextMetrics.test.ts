// Deliberately NOT jsdom: this file exists to prove headless behaviour, and
// jsdom supplies a `document`, which is exactly the condition being excluded.
// vitest's default `node` environment has no `document` at all.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearFontMetrics,
  registerFontMetrics,
  registerMSDFFontMetrics,
  resetUnmeasuredGlyphCount,
  setUnmeasuredGlyphWarning,
  unmeasuredGlyphCount,
} from '../src/index';
import { Scene } from '../src/tree/Scene';
import { SVGRenderer } from '../src/renderer/SVGRenderer';
import { TextEntity } from '../src/components/TextEntity';

/**
 * Real Chrome `sans-serif` em advances, collected with `measureText` at 100px
 * and divided by 100. Ground truth, not invented numbers — so a width computed
 * from them can be compared against what a browser would draw.
 */
const CHROME_EM: Record<string, number> = {
  W: 0.94385,
  i: 0.22217,
  A: 0.66699,
  V: 0.66699,
  H: 0.72217,
  e: 0.55371,
  l: 0.22217,
  o: 0.55664,
};

/** An `msdf-atlas-gen` document carrying those advances plus one kerning pair. */
const FONT_DATA = {
  atlas: {
    distanceRange: 2,
    size: 32,
    width: 64,
    height: 64,
    yOrigin: 'bottom' as const,
  },
  metrics: { emSize: 1, lineHeight: 1.25, ascender: 0.8, descender: -0.2 },
  glyphs: Object.entries(CHROME_EM).map(([char, advance]) => ({
    unicode: char.codePointAt(0) as number,
    advance,
  })),
  kerning: [{ unicode1: 0x41, unicode2: 0x56, advance: -0.0752 }],
};

/**
 * A canvas stand-in. `Scene` needs an object with these members but never gets a
 * 2D context out of it, and the SVG renderer does not touch it.
 */
function stubCanvas(): HTMLCanvasElement {
  return {
    width: 800,
    height: 600,
    style: {} as Record<string, string>,
    getContext: () => null,
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      top: 0,
      left: 0,
      right: 800,
      bottom: 600,
    }),
  } as unknown as HTMLCanvasElement;
}

function headlessScene(): Scene {
  return new Scene(stubCanvas(), {
    renderer: new SVGRenderer(800, 600),
    disableWindowResize: true,
  });
}

const EMPTY_ATLAS = Object.freeze({});

/** Lay out `text` at `fontSize` and return the entity's measured width. */
function textWidth(text: string, fontSize = 32, maxWidth = 1e9): number {
  const scene = headlessScene();
  try {
    const entity = new TextEntity(text, EMPTY_ATLAS, maxWidth, fontSize);
    scene.add(entity);
    return entity.width;
  } finally {
    scene.destroy();
  }
}

beforeEach(() => {
  clearFontMetrics();
  resetUnmeasuredGlyphCount();
  setUnmeasuredGlyphWarning(false);
});

afterEach(() => {
  clearFontMetrics();
  setUnmeasuredGlyphWarning(true);
  resetUnmeasuredGlyphCount();
});

describe('headless text measurement', () => {
  it('has no document, so this file really is testing the DOM-free path', () => {
    // Guards the guard: under jsdom every assertion below would pass for the
    // wrong reason, because a canvas measurer would be available.
    expect(typeof document).toBe('undefined');
  });

  it('falls back to a flat 0.5em per glyph with nothing registered', () => {
    // The historical behaviour, kept so an app that registers nothing is not
    // suddenly broken. 10 glyphs × 32px × 0.5 = 160.
    expect(textWidth('WWWWWWWWWW')).toBeCloseTo(160);
    expect(unmeasuredGlyphCount()).toBeGreaterThan(0);
  });

  it('measures a wide string correctly once metrics are registered', () => {
    registerFontMetrics('sans-serif', { advanceEm: (c) => CHROME_EM[c] });
    // Chrome measures this at 302.03px; the 0.5em guess said 160 (−47%).
    expect(textWidth('WWWWWWWWWW')).toBeCloseTo(302.03, 1);
    expect(unmeasuredGlyphCount()).toBe(0);
  });

  it('measures a narrow string correctly, where the guess was worst', () => {
    registerFontMetrics('sans-serif', { advanceEm: (c) => CHROME_EM[c] });
    // Chrome measures 71.09px; the guess said 160, i.e. +125%.
    expect(textWidth('iiiiiiiiii')).toBeCloseTo(71.09, 1);
  });

  it('no longer reports identical widths for narrow and wide text', () => {
    // The single clearest symptom of the flat fallback: 'i' × 10 and 'W' × 10
    // both came out at exactly 160.
    expect(textWidth('iiiiiiiiii')).toBe(textWidth('WWWWWWWWWW'));
    registerFontMetrics('sans-serif', { advanceEm: (c) => CHROME_EM[c] });
    const narrow = textWidth('iiiiiiiiii');
    const wide = textWidth('WWWWWWWWWW');
    expect(wide).toBeGreaterThan(narrow * 4);
  });

  it('scales with font size', () => {
    registerFontMetrics('sans-serif', { advanceEm: (c) => CHROME_EM[c] });
    expect(textWidth('WWWWWWWWWW', 16)).toBeCloseTo(textWidth('WWWWWWWWWW', 32) / 2, 4);
  });

  it('accepts an msdf-atlas-gen font as the metrics source', () => {
    registerMSDFFontMetrics('sans-serif', FONT_DATA);
    expect(textWidth('WWWWWWWWWW')).toBeCloseTo(302.03, 1);
  });
});

describe('headless toSVG geometry', () => {
  it('emits <text> at advancing x positions that match the registered metrics', () => {
    registerFontMetrics('sans-serif', { advanceEm: (c) => CHROME_EM[c] });
    const scene = headlessScene();
    try {
      const entity = new TextEntity('Hello', EMPTY_ATLAS, 1e9, 32);
      entity.x = 10;
      entity.y = 20;
      scene.add(entity);
      const svg = scene.toSVG();
      expect(svg).toContain('<text');
      // The serialized geometry is the real deliverable of this fix: an SSR
      // consumer reads these numbers, and before it they were fabricated.
      expect(entity.width).toBeCloseTo(
        (CHROME_EM.H + CHROME_EM.e + CHROME_EM.l * 2 + CHROME_EM.o) * 32,
        3,
      );
    } finally {
      scene.destroy();
    }
  });

  it('wraps at a width computed from real advances, not the 0.5em guess', () => {
    const scene = headlessScene();
    try {
      // 'WWWWW' is 151.0px in reality but 80px under the guess, so a 120px wrap
      // width puts the two on opposite sides of the boundary — the guess fits it
      // on one line, real metrics do not.
      const guessed = new TextEntity('WWWWW', EMPTY_ATLAS, 120, 32);
      guessed.maxWidth = 120;
      scene.add(guessed);
      const guessedHeight = guessed.height;

      registerFontMetrics('sans-serif', { advanceEm: (c) => CHROME_EM[c] });
      const measured = new TextEntity('WWWWW', EMPTY_ATLAS, 120, 32);
      measured.maxWidth = 120;
      scene.add(measured);

      expect(measured.height).toBeGreaterThan(guessedHeight);
    } finally {
      scene.destroy();
    }
  });
});
