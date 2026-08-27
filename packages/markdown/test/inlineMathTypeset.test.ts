// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { OBJECT_REPLACEMENT, type StyledSpan } from '@vectojs/core';
import { Markdown, preloadMathJax } from '../src/Markdown';

/**
 * Inline `$...$` typesetting.
 *
 * Inline math used to render as gold (`#fcd34d`) TeX source with the `$`
 * delimiters visible, because `collectSpans` pushed `token.raw` and never called
 * MathJax. It now reserves an inline box via `StyledSpan.object`.
 *
 * MathJax is imported lazily, so the first formula in a process cannot be typeset
 * in the same tick. Preloading here makes these assertions about WHAT is produced
 * rather than about load timing — the same approach `streamingMath.test.ts` uses.
 * The unloaded-MathJax fallback is covered in `Markdown.test.ts`, which never
 * preloads.
 */
beforeAll(async () => {
  await preloadMathJax();
});

/** Every span on every RichText in the tree, in document order. */
function spansOf(md: Markdown): StyledSpan[] {
  const out: StyledSpan[] = [];
  const walk = (e: any): void => {
    if (Array.isArray(e.spans)) out.push(...(e.spans as StyledSpan[]));
    for (const c of e.children ?? []) walk(c);
  };
  walk(md.content);
  return out;
}

const objectSpans = (md: Markdown): StyledSpan[] =>
  spansOf(md).filter((s) => s.object !== undefined);

const textOf = (md: Markdown): string =>
  spansOf(md)
    .map((s) => s.text)
    .join('');

describe('inline math is typeset into a reserved inline object', () => {
  it('replaces the gold TeX source with an inline object', () => {
    const md = new Markdown('The equation $x+1$ holds.');
    const objects = objectSpans(md);
    expect(objects).toHaveLength(1);
    // The old rendering: gold source text. Must be gone.
    expect(spansOf(md).some((s) => s.style?.color === '#fcd34d')).toBe(false);
  });

  it('does not leave the $ delimiters visible', () => {
    const md = new Markdown('The equation $x+1$ holds.');
    // The sentinel replaces the whole `$x+1$` run, delimiters included.
    expect(textOf(md)).not.toContain('$');
    expect(textOf(md)).toContain('The equation ');
    expect(textOf(md)).toContain(' holds.');
  });

  it('uses a single U+FFFC as the span text', () => {
    const md = new Markdown('a $x$ b');
    const [obj] = objectSpans(md);
    expect(obj.text).toBe(OBJECT_REPLACEMENT);
    expect(obj.text).toHaveLength(1);
  });

  it('carries the TeX source as the accessible name', () => {
    const md = new Markdown('The equation $x+1$ holds.');
    const [obj] = objectSpans(md);
    expect(obj.object!.alt).toBe('x+1');
  });

  it('reserves a positive box', () => {
    const md = new Markdown('a $x+1$ b');
    const box = objectSpans(md)[0].object!;
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
  });

  it('typesets several formulas in one paragraph independently', () => {
    const md = new Markdown('Both $x$ and $\\sum_{i=0}^{n} i$ appear.');
    const objects = objectSpans(md);
    expect(objects).toHaveLength(2);
    expect(objects[0].object!.alt).toBe('x');
    expect(objects[1].object!.alt).toBe('\\sum_{i=0}^{n} i');
    // A big operator with limits is far wider than a single letter; if these
    // matched, both would be sharing one cached box.
    expect(objects[1].object!.width).toBeGreaterThan(objects[0].object!.width);
  });

  it('gives a descending formula a larger depth than a bare one', () => {
    const depthOf = (src: string): number => objectSpans(new Markdown(src))[0].object!.depth ?? 0;
    // `x_1`'s subscript drops below the baseline; a lone `x` essentially sits on
    // it. Measured on the raw SVG: -0.339ex vs -0.025ex, and a fraction -0.798ex.
    expect(depthOf('a $x_1$ b')).toBeGreaterThan(depthOf('a $x$ b'));
    expect(depthOf('a $\\frac{a}{b}$ b')).toBeGreaterThan(depthOf('a $x_1$ b'));
  });

  it('scales the box with the run font size', () => {
    // A heading renders at a larger size than body prose, so the same formula
    // must reserve a larger box there. This is what the old hardcoded `ex * 8`
    // could not do.
    const body = new Markdown('$x+1$');
    const heading = new Markdown('# $x+1$');
    const bodyBox = objectSpans(body)[0].object!;
    const headingBox = objectSpans(heading)[0].object!;
    expect(headingBox.width).toBeGreaterThan(bodyBox.width);
    expect(headingBox.height).toBeGreaterThan(bodyBox.height);
  });
});

describe('inline $$...$$ is also typeset inline (StackEdit compat)', () => {
  it('renders inline $$...$$ as an inline object', () => {
    const md = new Markdown('行内 $$a+b$$ 测试');
    const objects = objectSpans(md);
    expect(objects).toHaveLength(1);
    expect(objects[0].object!.alt).toBe('a+b');
    expect(textOf(md)).not.toContain('$');
    expect(textOf(md)).toContain('行内 ');
    expect(textOf(md)).toContain(' 测试');
  });

  it('produces no stray dollars for $$ with trailing prose', () => {
    const md = new Markdown('$$a+b$$ 测试');
    expect(objectSpans(md)).toHaveLength(1);
    expect(objectSpans(md)[0].object!.alt).toBe('a+b');
    expect(textOf(md)).not.toContain('$');
  });

  it('treats alone $$...$$ on its own line as display block, not inline', () => {
    const md = new Markdown('$$a+b$$');
    // A standalone $$ block is display math (MathBlock), not an inline object.
    // Inline $$ inside paragraph should be inline, but line-start $$ without
    // trailing prose must remain display.
    const walk = (e: any, out: any[] = []): any[] => {
      out.push(e);
      for (const c of e.children ?? []) walk(c, out);
      return out;
    };
    const blocks = walk(md.content).filter((e: any) => e.constructor.name === 'MathBlock');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].formula).toBe('a+b');
  });
});

describe('inline math in nested block types', () => {
  // Each of these nests inline math somewhere `containsInlineMath` has to
  // recurse into. A missed site means the formula never typesets at all.
  const cases: Array<[string, string]> = [
    ['heading', '# see $x+1$ here'],
    ['list item', '- see $x+1$ here'],
    ['blockquote', '> see $x+1$ here'],
    ['table cell', '| a |\n| - |\n| $x+1$ |'],
    ['bold', 'see **$x+1$** here'],
    ['link text', 'see [$x+1$](https://example.com) here'],
  ];

  for (const [label, source] of cases) {
    it(`typesets inline math inside a ${label}`, () => {
      const md = new Markdown(source);
      const objects = objectSpans(md);
      expect(objects.length).toBeGreaterThanOrEqual(1);
      expect(objects[0].object!.alt).toBe('x+1');
    });
  }
});

describe('currency is still not typeset', () => {
  // The tokenizer-level guards from Markdown.test.ts, re-asserted with MathJax
  // LOADED: those pass trivially while every formula falls back to source text,
  // so they cannot show that currency avoids the typeset path.
  it('does not typeset "$5 to $10"', () => {
    const md = new Markdown('It costs $5 to $10 per unit.');
    expect(objectSpans(md)).toHaveLength(0);
    expect(textOf(md)).toContain('$5');
    expect(textOf(md)).toContain('$10');
  });

  it('does not typeset "$9 each, down from $12."', () => {
    const md = new Markdown('Only $9 each, down from $12.');
    expect(objectSpans(md)).toHaveLength(0);
  });

  it('does not typeset an empty "$$" pair', () => {
    const md = new Markdown('An empty $$ pair.');
    expect(objectSpans(md)).toHaveLength(0);
  });
});

/**
 * Painting the reserved box.
 *
 * The reservation shipped first and nothing drew into it, so a correctly measured,
 * positioned, accessible formula rendered as a blank gap. These pin the wiring
 * that fills it.
 *
 * What they deliberately do NOT assert is a decoded raster. Measured: Bun has no
 * `globalThis.Image`, and jsdom has one that never settles a `data:` URI — a probe
 * awaiting `onload`/`onerror` on an SVG data URI got neither within 400ms. The
 * decoded branch is therefore unobservable under vitest in either environment, and
 * `e2e/lazy-math.e2e.ts` is the only gate that can see real pixels.
 */
describe('inline math painting', () => {
  it('attaches a painter to the reserved box', () => {
    const md = new Markdown('Given $x+1$ we proceed.');
    const [span] = objectSpans(md);
    expect(span).toBeDefined();
    // Without this the box is reserved and stays empty forever.
    expect(typeof span.object?.paint).toBe('function');
  });

  it('draws into the box once the raster has decoded', () => {
    const md = new Markdown('Given $x+1$ we proceed.');
    const paint = objectSpans(md)[0]?.object?.paint;
    expect(paint).toBeDefined();

    const drawn: Array<{ dx: number; dy: number; dw: number; dh: number }> = [];
    const surface = {
      drawImage: (_s: CanvasImageSource, dx: number, dy: number, dw: number, dh: number) =>
        drawn.push({ dx, dy, dw, dh }),
    };
    const box = { x: 11, y: 22, width: 33, height: 44 };

    // jsdom never settles the data URI, so this is the still-loading path: draw
    // nothing rather than a placeholder slab, which would flash a grey rectangle
    // mid-sentence on every first paint.
    paint!(surface, box);
    expect(drawn).toHaveLength(0);
  });

  it('does not throw when the environment has no Image constructor', () => {
    const original = globalThis.Image;
    // SSR and plain (non-jsdom) unit runs. A formula must degrade to a blank box
    // rather than throwing out of a paint.
    // @ts-expect-error deliberately removing a global for the duration of the test
    delete globalThis.Image;
    try {
      const md = new Markdown('Given $x+1$ we proceed.');
      const paint = objectSpans(md)[0]?.object?.paint;
      expect(paint).toBeDefined();
      expect(() =>
        paint!({ drawImage: () => {} }, { x: 0, y: 0, width: 10, height: 10 }),
      ).not.toThrow();
    } finally {
      globalThis.Image = original;
    }
  });

  it('releases its repaint subscription on destroy', () => {
    // The waiter set is module-level and lives as long as the page, so a retained
    // closure would keep the whole destroyed entity tree alive.
    const md = new Markdown('Given $x+1$ we proceed.');
    const held = md as unknown as { inlineMathRepaint?: () => void };
    expect(typeof held.inlineMathRepaint).toBe('function');
    md.destroy();
    expect(held.inlineMathRepaint).toBeUndefined();
  });
});
