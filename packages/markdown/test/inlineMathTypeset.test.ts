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
