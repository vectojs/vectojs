// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { CodeBlock, MathBlock, Markdown, preloadMathJax } from '../src/Markdown';

/**
 * Every test in this file is about WHAT gets typeset, not about when MathJax
 * arrives, so it preloads once and then asserts synchronously as it always has.
 *
 * MathJax is imported lazily (see `preloadMathJax`), which means the first
 * formula in a process cannot be typeset in the same tick. Preloading here keeps
 * these assertions testing fence closure, caching, and entity shape rather than
 * accidentally re-testing load timing. The lazy-arrival behaviour itself is
 * covered separately in `lazyMathJax.test.ts`, which relies on vitest isolating
 * module state per file so it still observes an unloaded MathJax.
 */
beforeAll(async () => {
  await preloadMathJax();
});

/**
 * `renderMathToSVGDataURI` base64s the SVG with `btoa` on every REAL conversion
 * and not at all on a cache hit, so spying on it counts MathJax invocations
 * without exporting internals. `mathCache` is module-level and deliberately
 * shared across instances, so every test that counts conversions must use a
 * formula unique to itself — otherwise an earlier test's entry makes it pass for
 * the wrong reason.
 */
function countConversions(): { calls: () => number; restore: () => void } {
  const spy = vi.spyOn(globalThis, 'btoa');
  return {
    calls: () => spy.mock.calls.length,
    restore: () => spy.mockRestore(),
  };
}

const firstChild = (md: Markdown) => md.content.children[0] as any;
/**
 * The first block's `MathBlock`, or null when it is not one.
 *
 * Was "the container's first child, if it is an `Image`". A typeset formula is now
 * an inline object inside a `RichText` so that it reaches selection and
 * find-in-page, and `MathBlock` IS the block wrapper rather than something holding
 * an `Image` — hence a direct type test rather than a descent into children.
 */
const mathBlockOf = (md: Markdown): MathBlock | null => {
  const container = firstChild(md);
  return container instanceof MathBlock ? container : null;
};

/** Every `MathBlock` anywhere in the tree, for the nested (blockquote) cases. */
const mathBlocksIn = (md: Markdown): MathBlock[] => {
  const found: MathBlock[] = [];
  const walk = (e: any) => {
    if (e instanceof MathBlock) found.push(e);
    for (const c of e.children ?? []) walk(c);
  };
  walk(md.content);
  return found;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('streaming math: conversion is deferred until the fence closes', () => {
  it('renders an unclosed math fence as a CodeBlock showing the TeX source', () => {
    const md = new Markdown('```math\n\\int_0^1 x');
    const child = firstChild(md);
    expect(child).toBeInstanceOf(CodeBlock);
    expect(child.source).toBe('\\int_0^1 x');
    expect(mathBlockOf(md)).toBeNull();
  });

  it('typesets a closed math fence as a MathBlock carrying the TeX source', () => {
    const md = new Markdown('```math\n\\alpha + \\beta\n```');
    expect(firstChild(md)).not.toBeInstanceOf(CodeBlock);
    const img = mathBlockOf(md);
    expect(img).not.toBeNull();
    expect(img!.formula).toBe('\\alpha + \\beta');
    expect(img!.svgUri.startsWith('data:image/svg+xml;base64,')).toBe(true);
  });

  it('does not invoke MathJax while the fence is still open', () => {
    const counter = countConversions();
    const md = new Markdown('```math');
    md.appendMarkdown('\n\\gamma^{open}');
    md.appendMarkdown(' + \\delta');
    expect(counter.calls()).toBe(0);
    expect(firstChild(md)).toBeInstanceOf(CodeBlock);
    counter.restore();
  });

  it('converts exactly once across a formula streamed one chunk at a time', () => {
    const counter = countConversions();
    const md = new Markdown('```math');
    for (const chunk of ['\n', '\\zeta_{once}', ' = 1', ' + 2', '\n', '```', '\n']) {
      md.appendMarkdown(chunk);
    }
    // One conversion total: at the chunk that closed the fence. Before this
    // change every chunk converted, each on an invalid TeX prefix.
    expect(counter.calls()).toBe(1);
    expect(mathBlockOf(md)).not.toBeNull();
    counter.restore();
  });

  it('keeps the same CodeBlock entity while the fence grows, then replaces it once', () => {
    const md = new Markdown('```math\n\\eta');
    const openEntity = firstChild(md);
    md.appendMarkdown('_1');
    expect(firstChild(md)).toBe(openEntity); // in-place setCode, no rebuild
    md.appendMarkdown(' + \\theta');
    expect(firstChild(md)).toBe(openEntity);
    md.appendMarkdown('\n```');
    // The closing fence must break reuse: a CodeBlock cannot become a MathBlock.
    expect(firstChild(md)).not.toBe(openEntity);
    expect(mathBlockOf(md)).not.toBeNull();
  });

  it('reuses the rendered formula when the newline after the fence arrives', () => {
    const md = new Markdown('```math\n\\iota\n```');
    const rendered = firstChild(md);
    const before = (md as any).streamStats.entitiesRebuilt;
    md.appendMarkdown('\n');
    // `raw` grew so the prefix match stops short, but the formula is unchanged.
    // Rebuilding here would re-decode the SVG for no visible difference.
    expect(firstChild(md)).toBe(rendered);
    expect((md as any).streamStats.entitiesRebuilt).toBe(before);
  });
});

describe('streaming math: formula cache', () => {
  it('converts a repeated formula once', () => {
    const counter = countConversions();
    const formula = '\\kappa_{cached} = \\lambda';
    new Markdown(`\`\`\`math\n${formula}\n\`\`\``);
    const afterFirst = counter.calls();
    expect(afterFirst).toBe(1);
    new Markdown(`\`\`\`math\n${formula}\n\`\`\``);
    new Markdown(`\`\`\`latex\n${formula}\n\`\`\``);
    expect(counter.calls()).toBe(afterFirst);
    counter.restore();
  });

  it('produces a byte-identical data URI on a cache hit', () => {
    const formula = '\\mu_{identical}^2';
    const a = mathBlockOf(new Markdown(`\`\`\`math\n${formula}\n\`\`\``));
    const b = mathBlockOf(new Markdown(`\`\`\`math\n${formula}\n\`\`\``));
    expect(a).not.toBeNull();
    expect(b!.svgUri).toBe(a!.svgUri);
    expect(b!.width).toBe(a!.width);
    expect(b!.height).toBe(a!.height);
  });

  it('does not confuse two different formulas', () => {
    const one = mathBlockOf(new Markdown('```math\n\\nu_{first}\n```'));
    const two = mathBlockOf(new Markdown('```math\n\\nu_{second}\n```'));
    expect(one!.svgUri).not.toBe(two!.svgUri);
  });
});

describe('streaming math: fence closure detection', () => {
  const typesetsAsMath = (src: string) => mathBlockOf(new Markdown(src)) !== null;

  it('accepts every math language alias', () => {
    expect(typesetsAsMath('```math\nx\n```')).toBe(true);
    expect(typesetsAsMath('```latex\nx\n```')).toBe(true);
    expect(typesetsAsMath('```tex\nx\n```')).toBe(true);
    expect(typesetsAsMath('```TeX\nx\n```')).toBe(true);
  });

  it('accepts a tilde fence and a longer-than-three fence', () => {
    expect(typesetsAsMath('~~~math\nx\n~~~')).toBe(true);
    expect(typesetsAsMath('````math\nx\n````')).toBe(true);
  });

  it('requires the closing fence to use the opening fence character', () => {
    // A `~~~` line does not close a ``` fence, so this is still open.
    expect(typesetsAsMath('```math\nx\n~~~')).toBe(false);
  });

  it('requires the closing fence to be at least as long as the opening', () => {
    expect(typesetsAsMath('````math\nx\n```')).toBe(false);
  });

  it('treats an indented closing fence as closing', () => {
    expect(typesetsAsMath('```math\nx\n  ```')).toBe(true);
  });

  it('leaves a non-math fence alone whether closed or not', () => {
    expect(typesetsAsMath('```ts\nconst x = 1;\n```')).toBe(false);
    expect(firstChild(new Markdown('```ts\nconst x = 1;\n```'))).toBeInstanceOf(CodeBlock);
  });

  it('renders an empty closed math fence as a CodeBlock, not a zero-size image', () => {
    const md = new Markdown('```math\n```');
    expect(firstChild(md)).toBeInstanceOf(CodeBlock);
    expect(mathBlockOf(md)).toBeNull();
  });
});

describe('streaming math inside a blockquote', () => {
  it('renders a closed nested formula as a MathBlock', () => {
    const md = new Markdown('> intro\n>\n> ```math\n> \\rho_{quoted}\n> ```');
    const found = mathBlocksIn(md);
    expect(found.length).toBe(1);
    expect(found[0].formula).toBe('\\rho_{quoted}');
  });

  it('refuses tail reuse when a nested fence closes, so the formula typesets', () => {
    const md = new Markdown('> ```math\n> \\sigma_{tail}');
    const openInner = (md.content.children[0] as any).children[1].children.at(-1).children[0];
    expect(openInner).toBeInstanceOf(CodeBlock);
    md.appendMarkdown('\n> ```');
    const found = mathBlocksIn(md);
    expect(found.length).toBe(1);
    expect(found[0].formula).toBe('\\sigma_{tail}');
  });

  it('still reuses a nested non-math code fence in place', () => {
    const md = new Markdown('> ```ts\n> const a = 1;');
    const inner = (md.content.children[0] as any).children[1].children.at(-1).children[0];
    expect(inner).toBeInstanceOf(CodeBlock);
    md.appendMarkdown('\n> const b = 2;');
    const after = (md.content.children[0] as any).children[1].children.at(-1).children[0];
    expect(after).toBe(inner);
  });
});

describe('streaming math: async SVG decode repaints the scene', () => {
  it('marks the scene dirty when the formula raster decodes', () => {
    // The repaint route changed with the formula's rendering. It used to be
    // `Image`'s own `onLoad`, reachable directly on the entity. A formula is now an
    // inline object whose raster is shared and decoded lazily on first paint, so
    // this drives the real path: paint once to start the decode, then fire the
    // bitmap's `onload` the way the browser would. Asserting through the actual
    // path is the point — a stub on the entity would no longer prove a repaint
    // happens.
    const created: any[] = [];
    const RealImage = globalThis.Image;
    // @ts-expect-error swapping a global for the duration of the test
    globalThis.Image = class {
      public onload: (() => void) | null = null;
      public src = '';
      constructor() {
        created.push(this);
      }
    };
    try {
      const md = new Markdown('```math\n\\tau_{decode}\n```');
      const markDirty = vi.fn();
      // `Entity.scene` is a getter that walks up to the nearest `_scene`, so the
      // stub has to be installed on the private field the getter reads.
      (md as any)._scene = { markDirty };
      const block = mathBlockOf(md);
      expect(block).not.toBeNull();

      // First paint is what starts the decode; nothing is drawn yet.
      const richText = block!.children[0] as any;
      const paint = richText.spans[0].object.paint as (s: unknown, b: unknown) => void;
      paint({ drawImage: () => {} }, { x: 0, y: 0, width: 10, height: 10 });
      expect(created.length).toBeGreaterThan(0);
      expect(markDirty).not.toHaveBeenCalled();

      // Simulate the browser finishing the data-URI decode.
      created[created.length - 1].onload?.();
      expect(markDirty).toHaveBeenCalled();
    } finally {
      globalThis.Image = RealImage;
    }
  });
});
