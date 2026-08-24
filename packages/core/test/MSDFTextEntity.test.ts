// @vitest-environment jsdom
import { test, expect, vi, beforeAll, afterEach } from 'vitest';
import { MSDFFont } from '@vectojs/text';
import { MSDFTextEntity } from '../src/text/MSDFTextEntity';
import { Entity } from '../src/tree/Entity';
import { LayoutWorkerManager } from '@vectojs/layout';
import fontJson from './fixtures/font.json';

// Mock Worker and URL.createObjectURL since they are not supported in JSDOM/Node environment
class MockWorker {
  public onmessage?: (e: MessageEvent) => void;
  public postMessage(data: any) {
    const { id, seqId, text, fontSize, lineHeight } = data;
    const codePoints = Array.from(text).map((c) => c.charCodeAt(0));
    const xCoords = codePoints.map((_, i) => i * 10);
    const yCoords = codePoints.map(() => fontSize);
    const packedStyles = codePoints.map(() => (0xffffff << 8) | 0);
    const actualLineHeight = lineHeight ?? fontSize * 1.0;

    setTimeout(() => {
      if (this.onmessage) {
        this.onmessage({
          data: {
            id,
            seqId,
            width: text.length * 10,
            height: actualLineHeight,
            codePoints: new Uint32Array(codePoints),
            xCoords: new Float32Array(xCoords),
            yCoords: new Float32Array(yCoords),
            packedStyles: new Uint32Array(packedStyles),
          },
        } as MessageEvent);
      }
    }, 10);
  }
  public terminate() {}
}

beforeAll(() => {
  globalThis.Worker = MockWorker as any;
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');
  globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  LayoutWorkerManager.getInstance().destroy();
});

test('MSDFTextEntity properties and boundary calculations', () => {
  const font = new MSDFFont(fontJson);
  const mockTexture = {} as TexImageSource;
  const entity = new MSDFTextEntity('Vecto', {
    font,
    texture: mockTexture,
    fontSize: 24,
  });

  expect(entity.isPointInside(10, 10)).toBe(false);
  entity.destroy();
});

test('MSDFTextEntity passes a configurable wrap width to the layout worker', () => {
  const font = new MSDFFont(fontJson);
  const queueLayout = vi.spyOn(LayoutWorkerManager.getInstance(), 'queueLayout');
  const entity = new MSDFTextEntity('Vecto', {
    font,
    texture: {} as TexImageSource,
    fontSize: 24,
    maxWidth: 320,
  });

  expect(queueLayout).toHaveBeenCalledTimes(1);
  expect(queueLayout.mock.calls[0][2].maxWidth).toBe(320);

  // Changing the wrap width re-queues layout for the current text.
  entity.setMaxWidth(480);
  expect(queueLayout).toHaveBeenCalledTimes(2);
  expect(queueLayout.mock.calls[1][2].maxWidth).toBe(480);

  // Same width is a no-op.
  entity.setMaxWidth(480);
  expect(queueLayout).toHaveBeenCalledTimes(2);

  // Default stays at the historical 1000 when unspecified.
  queueLayout.mockClear();
  new MSDFTextEntity('x', { font, texture: {} as TexImageSource });
  expect(queueLayout.mock.calls[0][2].maxWidth).toBe(1000);
  queueLayout.mockRestore();
});

test('MSDFTextEntity threads textAlign to the layout worker', () => {
  const font = new MSDFFont(fontJson);
  const queueLayout = vi.spyOn(LayoutWorkerManager.getInstance(), 'queueLayout');

  // Default is left.
  const entity = new MSDFTextEntity('Vecto', {
    font,
    texture: {} as TexImageSource,
  });
  expect(queueLayout.mock.calls[0][2].textAlign).toBe('left');

  // setTextAlign re-queues with the new alignment.
  entity.setTextAlign('justify');
  expect(queueLayout).toHaveBeenCalledTimes(2);
  expect(queueLayout.mock.calls[1][2].textAlign).toBe('justify');

  // Same alignment is a no-op.
  entity.setTextAlign('justify');
  expect(queueLayout).toHaveBeenCalledTimes(2);

  // The constructor option is honored up-front.
  queueLayout.mockClear();
  new MSDFTextEntity('x', {
    font,
    texture: {} as TexImageSource,
    textAlign: 'justify',
  });
  expect(queueLayout.mock.calls[0][2].textAlign).toBe('justify');
  queueLayout.mockRestore();
});

test('MSDFTextEntity setHyphenator injects soft hyphens into the layout string only', () => {
  const font = new MSDFFont(fontJson);
  const queueLayout = vi.spyOn(LayoutWorkerManager.getInstance(), 'queueLayout');
  const SHY = '\u00ad';

  const entity = new MSDFTextEntity('hyphenation test', {
    font,
    texture: {} as TexImageSource,
  });
  // No hyphenator: the layout string is the text unchanged.
  expect(queueLayout.mock.calls[0][1]).toBe('hyphenation test');

  // Split every long word after its 3rd char, e.g. 'hyphenation' → 'hyp','henation'.
  entity.setHyphenator((word) => (word.length > 3 ? [word.slice(0, 3), word.slice(3)] : [word]));
  const sentText = queueLayout.mock.calls[1][1];
  // Long words gain a soft hyphen; the short word 'test' (>3) also splits.
  expect(sentText).toContain(SHY);
  expect(sentText).toBe(`hyp${SHY}henation tes${SHY}t`);

  // The original text (a11y / content projection) is NOT mutated.
  expect(entity.getContentProjection()?.text).toBe('hyphenation test');

  // Disabling restores the plain layout string.
  entity.setHyphenator(null);
  const restored = queueLayout.mock.calls[queueLayout.mock.calls.length - 1][1];
  expect(restored).toBe('hyphenation test');
  queueLayout.mockRestore();
});

test('MSDFTextEntity WebGL rendering under rotation', () => {
  const font = new MSDFFont(fontJson);
  const mockTexture = {} as TexImageSource;
  const entity = new MSDFTextEntity('AB', {
    font,
    texture: mockTexture,
    fontSize: 24,
  });

  // Populate fake layout response
  entity['layoutResult'] = {
    width: 100,
    height: 24,
    codePoints: new Uint32Array([65, 66]),
    xCoords: new Float32Array([0, 10]),
    yCoords: new Float32Array([18, 18]),
    packedStyles: new Uint32Array([0xffffff << 8, 0xffffff << 8]),
  };

  entity.rotation = Math.PI / 4; // 45 degrees

  const mockAddGlyph = vi.fn();
  const mockSetMSDFTexture = vi.fn();

  (entity as any)._scene = {
    pointRenderer: {
      setMSDFTexture: mockSetMSDFTexture,
      addGlyph: mockAddGlyph,
    },
    glCanvas: {},
    markDirty: vi.fn(),
  };

  entity.render(null);

  expect(mockSetMSDFTexture).toHaveBeenCalledWith(mockTexture, font.distanceRange);
  expect(mockAddGlyph).toHaveBeenCalledTimes(2);

  // Check the coordinates passed to addGlyph are computed and rotated
  const call1 = mockAddGlyph.mock.calls[0];
  // addGlyph signature: x, y, width, height, u0, v0, u1, v1, color, alpha, rotation
  expect(call1[10]).toBeCloseTo(Math.PI / 4);
});

test('MSDFTextEntity WebGL path multiplies ancestor opacity into glyph alpha', () => {
  const font = new MSDFFont(fontJson);
  const mockTexture = {} as TexImageSource;
  const entity = new MSDFTextEntity('A', {
    font,
    texture: mockTexture,
    fontSize: 24,
  });
  entity['layoutResult'] = {
    width: 100,
    height: 24,
    codePoints: new Uint32Array([65]),
    xCoords: new Float32Array([0]),
    yCoords: new Float32Array([18]),
    packedStyles: new Uint32Array([0xffffff << 8]),
  };
  entity.opacity = 0.5;

  // Real ancestor at opacity 0.5 → world opacity 0.25.
  const parent = new (class extends Entity {
    isPointInside() {
      return false;
    }
    render() {}
  })('opacity-parent');
  parent.opacity = 0.5;
  parent.add(entity);

  const mockAddGlyph = vi.fn();
  (parent as any)._scene = {
    pointRenderer: { setMSDFTexture: vi.fn(), addGlyph: mockAddGlyph },
    glCanvas: {},
    markDirty: vi.fn(),
  };

  entity.render(null);
  expect(mockAddGlyph).toHaveBeenCalledTimes(1);
  // addGlyph signature: x, y, width, height, u0, v0, u1, v1, color, alpha, rotation
  expect(mockAddGlyph.mock.calls[0][9]).toBeCloseTo(0.25);
});

test('MSDFTextEntity Canvas2D rendering fallback', () => {
  const font = new MSDFFont(fontJson);
  const mockTexture = {} as TexImageSource;
  const entity = new MSDFTextEntity('AB', {
    font,
    texture: mockTexture,
    fontSize: 24,
  });

  entity['layoutResult'] = {
    width: 100,
    height: 24,
    codePoints: new Uint32Array([65, 66]),
    xCoords: new Float32Array([0, 10]),
    yCoords: new Float32Array([18, 18]),
    packedStyles: new Uint32Array([0xffffff << 8, 0xffffff << 8]),
  };

  const mockRenderer = {
    fillText: vi.fn(),
  };

  entity.render(mockRenderer);

  expect(mockRenderer.fillText).toHaveBeenCalledTimes(2);
  expect(mockRenderer.fillText).toHaveBeenNthCalledWith(
    1,
    'A',
    0,
    18,
    '24px sans-serif',
    '#ffffff',
  );
  expect(mockRenderer.fillText).toHaveBeenNthCalledWith(
    2,
    'B',
    10,
    18,
    '24px sans-serif',
    '#ffffff',
  );

  entity.setPosition(30, 50);
  entity.scaleX = 2;
  entity.scaleY = 0.5;
  entity.rotation = Math.PI / 4;
  const inside = entity.localToWorld(50, 12);
  const outside = entity.localToWorld(101, 12);
  expect(entity.isPointInside(inside.x, inside.y)).toBe(true);
  expect(entity.isPointInside(outside.x, outside.y)).toBe(false);
});

test('MSDFTextEntity falls back to Canvas for a sheared world transform', () => {
  const font = new MSDFFont(fontJson);
  const entity = new MSDFTextEntity('A', {
    font,
    texture: {} as TexImageSource,
    fontSize: 24,
  });
  entity['layoutResult'] = {
    width: 20,
    height: 24,
    codePoints: new Uint32Array([65]),
    xCoords: new Float32Array([0]),
    yCoords: new Float32Array([18]),
    packedStyles: new Uint32Array([0xffffff << 8]),
  };
  entity.scaleX = 2;
  entity.scaleY = 0.5;
  entity.rotation = Math.PI / 4;
  const addGlyph = vi.fn();
  (entity as any)._scene = {
    pointRenderer: { setMSDFTexture: vi.fn(), addGlyph },
    glCanvas: {},
  };
  const renderer = { fillText: vi.fn() };

  entity.render(renderer);

  expect(addGlyph).not.toHaveBeenCalled();
  expect(renderer.fillText).toHaveBeenCalledOnce();
});

test('MSDFTextEntity exposes its text and font for the DOM content mirror', () => {
  const font = new MSDFFont(fontJson);
  const entity = new MSDFTextEntity('MSDF findable', {
    font,
    texture: {} as TexImageSource,
    fontSize: 32,
    lineHeight: 40,
  });
  const proj = entity.getContentProjection()!;
  expect(proj.text).toBe('MSDF findable');
  expect(proj.font).toBe('32px sans-serif');
  expect(proj.lineHeight).toBe(40);
});

test('MSDFTextEntity projection pins baseline and line rhythm from font metrics', () => {
  const font = new MSDFFont(fontJson);
  const entity = new MSDFTextEntity('MSDF findable', {
    font,
    texture: {} as TexImageSource,
    fontSize: 32,
  });
  const proj = entity.getContentProjection()!;
  // Font metrics: ascender 0.8, descender -0.2 → baseline 0.8em, pitch 1.0em.
  expect(proj.baseline).toBeCloseTo(25.6, 5);
  expect(proj.lineHeight).toBe(32);
  // No layout reply yet → no per-line carriers, only the coarse alignment.
  expect(proj.lines).toBeUndefined();

  // An explicit lineHeight option wins over the metric-derived pitch.
  const withLh = new MSDFTextEntity('x', {
    font,
    texture: {} as TexImageSource,
    fontSize: 32,
    lineHeight: 40,
  });
  expect(withLh.getContentProjection()!.lineHeight).toBe(40);
});

test('MSDFTextEntity projection emits per-line carriers from a layout reply', () => {
  const font = new MSDFFont(fontJson);
  const entity = new MSDFTextEntity('ab\ncd', {
    font,
    texture: {} as TexImageSource,
    fontSize: 24,
  });
  entity['layoutResult'] = {
    width: 40,
    height: 48,
    codePoints: new Uint32Array([97, 98, 99, 100]),
    xCoords: new Float32Array([0, 10, 0, 10]),
    yCoords: new Float32Array([19.2, 19.2, 43.2, 43.2]),
    packedStyles: new Uint32Array([
      (0xffffff << 8) | 0,
      (0xffffff << 8) | 0,
      (0xffffff << 8) | 0,
      (0xffffff << 8) | 0,
    ]),
  };
  entity['rebuildProjectionLines']();
  const proj = entity.getContentProjection()!;
  expect(proj.lines).toHaveLength(2);
  expect(proj.lines![0]).toMatchObject({ text: 'ab', x: 0, y: 0, lineHeight: 24 });
  expect(proj.lines![0].separatorAfter).toBe('\n');
  expect(proj.lines![0].baseline).toBeCloseTo(19.2, 5);
  expect(proj.lines![1]).toMatchObject({ text: 'cd', y: 24, lineHeight: 24 });
  expect(proj.lines![1].separatorAfter).toBe('');
});

test('MSDFTextEntity projection keeps blank rows byte-identical to the source', () => {
  const font = new MSDFFont(fontJson);
  const entity = new MSDFTextEntity('a\n\nb', {
    font,
    texture: {} as TexImageSource,
    fontSize: 24,
  });
  entity['layoutResult'] = {
    width: 20,
    height: 72,
    codePoints: new Uint32Array([97, 98]),
    xCoords: new Float32Array([0, 0]),
    yCoords: new Float32Array([19.2, 67.2]),
    packedStyles: new Uint32Array([(0xffffff << 8) | 0, (0xffffff << 8) | 0]),
  };
  entity['rebuildProjectionLines']();
  const proj = entity.getContentProjection()!;
  const rebuilt = proj.lines!.map((line) => `${line.text}${line.separatorAfter ?? ''}`).join('');
  expect(rebuilt).toBe('a\n\nb');
  expect(proj.lines).toHaveLength(3);
  expect(proj.lines![1].text).toBe('');
  expect(proj.lines![2].y).toBe(48);
});

test('MSDFTextEntity projection falls back when glyphs cannot map back to source', () => {
  const font = new MSDFFont(fontJson);
  // Shaping/bidi: the reply's glyph sequence differs from the source text, so
  // glyph offsets cannot be source offsets — coarse branch keeps correctness.
  const shaped = new MSDFTextEntity('مرحبا', {
    font,
    texture: {} as TexImageSource,
    fontSize: 24,
  });
  shaped['layoutResult'] = {
    width: 100,
    height: 24,
    codePoints: new Uint32Array([0x645, 0x631, 0x62d, 0x628]),
    xCoords: new Float32Array([0, 10, 20, 30]),
    yCoords: new Float32Array([19.2, 19.2, 19.2, 19.2]),
    packedStyles: new Uint32Array([
      (0xffffff << 8) | 0,
      (0xffffff << 8) | 0,
      (0xffffff << 8) | 0,
      (0xffffff << 8) | 0,
    ]),
  };
  shaped['rebuildProjectionLines']();
  expect(shaped.getContentProjection()!.lines).toBeUndefined();
  expect(shaped.getContentProjection()!.baseline).toBeCloseTo(19.2, 5);

  // Justify stretches glyph x away from natural flow; line carriers would
  // describe rows the fallback font cannot reproduce.
  const justified = new MSDFTextEntity('ab', {
    font,
    texture: {} as TexImageSource,
    fontSize: 24,
    textAlign: 'justify',
  });
  justified['layoutResult'] = {
    width: 100,
    height: 24,
    codePoints: new Uint32Array([97, 98]),
    xCoords: new Float32Array([0, 50]),
    yCoords: new Float32Array([19.2, 19.2]),
    packedStyles: new Uint32Array([(0xffffff << 8) | 0, (0xffffff << 8) | 0]),
  };
  justified['rebuildProjectionLines']();
  expect(justified.getContentProjection()!.lines).toBeUndefined();
});

/**
 * A minimal HTMLImageElement stand-in whose listeners can be fired on demand.
 * jsdom has `Image`, but a blob-backed one fires neither `load` nor `error`
 * (measured: 400 ms produced neither), so the decode has to be simulated.
 */
function fakeAtlas(complete = false) {
  const listeners = new Map<string, Set<() => void>>();
  return {
    complete,
    naturalWidth: complete ? 64 : 0,
    addEventListener(type: string, fn: () => void) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.get(type)?.delete(fn);
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
    fire(type: string) {
      // No snapshot needed: the handler under test removes itself from this very
      // Set, and deleting the current element mid-iteration is well-defined.
      const set = listeners.get(type);
      if (set) for (const fn of set) fn();
    },
  };
}

test('MSDFTextEntity repaints when a still-decoding atlas finishes loading', () => {
  const font = new MSDFFont(fontJson);
  const atlas = fakeAtlas();
  const entity = new MSDFTextEntity('Atlas', {
    font,
    texture: atlas as unknown as TexImageSource,
    fontSize: 24,
  });
  const markDirty = vi.fn();
  (entity as any)._scene = { markDirty };

  // The WebGL backend refuses to upload an undecoded atlas, so the upload has
  // to happen on a later frame — and nothing else schedules one. Measured in
  // both engines, the scene's own loop never came back for it.
  expect(atlas.listenerCount('load')).toBe(1);
  atlas.fire('load');
  expect(markDirty).toHaveBeenCalledOnce();

  // One-shot: the listener releases itself so a shared atlas image does not
  // accumulate a handler (and a `this` reference) per entity.
  expect(atlas.listenerCount('load')).toBe(0);
  entity.destroy();
});

test('MSDFTextEntity does not subscribe to an atlas that is already decoded', () => {
  const font = new MSDFFont(fontJson);
  const atlas = fakeAtlas(true);
  const entity = new MSDFTextEntity('Atlas', {
    font,
    texture: atlas as unknown as TexImageSource,
    fontSize: 24,
  });
  expect(atlas.listenerCount('load')).toBe(0);
  expect(atlas.listenerCount('error')).toBe(0);
  entity.destroy();
});

test('MSDFTextEntity releases its atlas listener on destroy', () => {
  const font = new MSDFFont(fontJson);
  const atlas = fakeAtlas();
  const entity = new MSDFTextEntity('Atlas', {
    font,
    texture: atlas as unknown as TexImageSource,
    fontSize: 24,
  });
  expect(atlas.listenerCount('load')).toBe(1);
  expect(atlas.listenerCount('error')).toBe(1);

  entity.destroy();

  // Both must go: the handler closes over the entity, so a long-lived shared
  // atlas would otherwise retain the whole tree after destroy().
  expect(atlas.listenerCount('load')).toBe(0);
  expect(atlas.listenerCount('error')).toBe(0);
});

test('MSDFTextEntity tolerates a texture with no decode state', () => {
  const font = new MSDFFont(fontJson);
  // A canvas / ImageBitmap atlas has no `complete` and no listener API; the
  // subscription must be skipped rather than throwing.
  expect(
    () =>
      new MSDFTextEntity('Atlas', {
        font,
        texture: {} as TexImageSource,
        fontSize: 24,
      }),
  ).not.toThrow();
});

test('MSDFTextEntity renders glyphs in the configured color on the WebGL path', () => {
  const font = new MSDFFont(fontJson);
  const entity = new MSDFTextEntity('A', {
    font,
    texture: {} as TexImageSource,
    fontSize: 24,
    color: '#ff2800',
  });
  entity['layoutResult'] = {
    width: 100,
    height: 24,
    codePoints: new Uint32Array([65]),
    xCoords: new Float32Array([0]),
    yCoords: new Float32Array([18]),
    // The layout worker still packs white; draw time must tint instead.
    packedStyles: new Uint32Array([(0xffffff << 8) | 0]),
  };
  const addGlyph = vi.fn();
  (entity as any)._scene = {
    pointRenderer: { setMSDFTexture: vi.fn(), addGlyph },
    glCanvas: {},
    markDirty: vi.fn(),
  };

  entity.render(null);

  expect(addGlyph).toHaveBeenCalledTimes(1);
  // addGlyph signature: x, y, width, height, u0, v0, u1, v1, color, alpha, rotation
  expect(addGlyph.mock.calls[0][8]).toBe('#ff2800');
  entity.destroy();
});

test('MSDFTextEntity honors color option and post-construction reassignment on Canvas2D', () => {
  const font = new MSDFFont(fontJson);
  const entity = new MSDFTextEntity('AB', {
    font,
    texture: {} as TexImageSource,
    fontSize: 24,
  });
  entity['layoutResult'] = {
    width: 100,
    height: 24,
    codePoints: new Uint32Array([65, 66]),
    xCoords: new Float32Array([0, 10]),
    yCoords: new Float32Array([18, 18]),
    packedStyles: new Uint32Array([(0xffffff << 8) | 0, (0xffffff << 8) | 0]),
  };
  const fillText = vi.fn();

  // Default stays white.
  entity.render({ fillText });
  expect(fillText.mock.calls[0][4]).toBe('#ffffff');

  // Assignment after construction must take effect on the next render.
  entity.color = 'rgb(10,200,40)';
  fillText.mockClear();
  entity.render({ fillText });
  expect(fillText).toHaveBeenCalledTimes(2);
  expect(fillText.mock.calls[0][4]).toBe('rgb(10,200,40)');
  expect(fillText.mock.calls[1][4]).toBe('rgb(10,200,40)');
  entity.destroy();
});

test('MSDFTextEntity never splits a surrogate pair across projected lines', () => {
  const font = new MSDFFont(fontJson);
  const entity = new MSDFTextEntity('\u{1F600}\nab', {
    font,
    texture: {} as TexImageSource,
    fontSize: 24,
    lineHeight: 24,
  });
  // Layout reply for "😀\nab": three glyphs (one per code point, newline
  // emits none), line 0 holds the emoji, line 1 holds "ab".
  const asc = font.data.metrics?.ascender ?? 0.8;
  const baseline = asc * 24;
  entity['layoutResult'] = {
    width: 100,
    height: 48,
    codePoints: new Uint32Array([0x1f600, 97, 98]),
    xCoords: new Float32Array([0, 10, 20]),
    yCoords: new Float32Array([baseline, baseline + 24, baseline + 24]),
    packedStyles: new Uint32Array([(0xffffff << 8) | 0, (0xffffff << 8) | 0, (0xffffff << 8) | 0]),
  };
  entity['rebuildProjectionLines']();
  const lines = entity.getContentProjection()!.lines!;
  expect(lines.length).toBe(2);
  // Line 0 must carry the WHOLE emoji — not its high surrogate half.
  expect(lines[0].text).toBe('\u{1F600}');
  expect(lines[1].text).toBe('ab');
  // And no LONE surrogate may leak into any carrier: strip every well-formed
  // pair first, then no bare surrogate unit may remain.
  const all = lines.map((l) => l.text + l.separatorAfter).join('|');
  const withoutPairs = all.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '');
  expect(withoutPairs).not.toMatch(/[\uD800-\uDFFF]/);
  entity.destroy();
});
