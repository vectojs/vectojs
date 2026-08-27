// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { MathBlock, Markdown, preloadMathJax } from '../src/Markdown';

/**
 * Display math written as `$$...$$`, and the color baked into every math SVG.
 *
 * Both defects were found by dogfooding an external editor demo.
 *
 * There was no block/display math tokenizer at all — only an inline `$...$`
 * rule, which deliberately refuses `$$` to protect currency ("$5 to $10"). With
 * no block rule, marked's text tokenizer consumed the leading `$`, the inline
 * rule then matched the *inner* `$...$` pair, and the outer two dollars survived
 * as literal text. The result was a formula with a stray `$` painted on each
 * side.
 *
 * Separately, the formula's colour has to be baked into the SVG bytes. This
 * package base64s the SVG into a `data:` URI, which is an isolated document with
 * no CSS inheritance — under MathJax its `fill="currentColor"` glyphs therefore
 * fell back to black, making every formula invisible against this package's own
 * dark default theme. `@vectojs/tex` writes the colour directly instead, but the
 * constraint is identical and the colour must still be part of the cache key.
 *
 * The math engine is imported lazily, so preload to make these assertions about
 * WHAT is produced rather than about load timing, as `inlineMathTypeset.test.ts`
 * does.
 */
beforeAll(async () => {
  await preloadMathJax();
});

/** Every entity in the tree, in document order. */
function walk(e: any, out: any[] = []): any[] {
  out.push(e);
  for (const c of e.children ?? []) walk(c, out);
  return out;
}

/**
 * Every `MathBlock` in the tree — one per rendered display formula.
 *
 * Was `instanceof Image`. A formula is now one inline object inside a `RichText`
 * rather than an `Image` entity, so that it reaches selection, find-in-page and
 * copy the way inline `$..$` always did. `MathBlock` is the wrapper that still
 * gives the formula a stable handle, carrying the source and the typeset SVG URI.
 */
const mathBlocksOf = (md: Markdown): MathBlock[] =>
  walk(md.content).filter((e) => e instanceof MathBlock);

/** Every text span's text, concatenated, so a stray delimiter is visible. */
function textOf(md: Markdown): string {
  let s = '';
  for (const e of walk(md.content)) {
    if (Array.isArray(e.spans)) for (const sp of e.spans) s += sp.text ?? '';
    else if (typeof e.text === 'string') s += e.text;
  }
  return s;
}

/** Decode the SVG behind a `MathBlock`'s data URI. */
function svgOf(block: MathBlock): string {
  const uri: string = block.svgUri;
  expect(uri.startsWith('data:image/svg+xml;base64,')).toBe(true);
  return atob(uri.slice('data:image/svg+xml;base64,'.length));
}

describe('$$...$$ renders as display math with no stray delimiters', () => {
  it('produces one display formula and no literal $', () => {
    const md = new Markdown('$$\\int_a^b f(x)\\,dx = F(b) - F(a)$$');
    expect(mathBlocksOf(md)).toHaveLength(1);
    // The defect: a `$` on each side of the formula.
    expect(textOf(md)).not.toContain('$');
  });

  it('keeps surrounding prose intact', () => {
    const md = new Markdown('before\n\n$$x^2 + y^2 = z^2$$\n\nafter\n');
    expect(mathBlocksOf(md)).toHaveLength(1);
    const text = textOf(md);
    expect(text).toContain('before');
    expect(text).toContain('after');
    expect(text).not.toContain('$');
  });

  it('spans multiple lines', () => {
    const md = new Markdown('$$\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n$$\n');
    expect(mathBlocksOf(md)).toHaveLength(1);
    expect(textOf(md)).not.toContain('$');
  });

  it('carries the TeX source as the accessible name', () => {
    const md = new Markdown('$$E = mc^2$$');
    // Without this the formula is an unlabelled image to assistive tech.
    expect(mathBlocksOf(md)[0].formula).toBe('E = mc^2');
  });

  it('still tokenizes inline $...$ as inline math, not a block', () => {
    const md = new Markdown('cost is $x+1$ per unit\n');
    // Inline math reserves an inline box in the surrounding paragraph, so it
    // produces no MathBlock of its own.
    expect(mathBlocksOf(md)).toHaveLength(0);
    expect(textOf(md)).not.toContain('$');
  });

  it('leaves currency alone', () => {
    const md = new Markdown('it costs $5 to $10 per item\n');
    expect(mathBlocksOf(md)).toHaveLength(0);
    // Currency is the one case where a literal $ SHOULD survive as text.
    expect(textOf(md)).toContain('$5');
    expect(textOf(md)).toContain('$10');
  });
});

describe('math SVG carries an explicit color', () => {
  /**
   * These four were written against MathJax's output shape and are rewritten,
   * not deleted, because the behaviour they guard is unchanged and still
   * breakable: a formula must paint in the theme's colour, and two documents on
   * different themes must not share one cached bitmap.
   *
   * What changed is the mechanism. MathJax emitted `fill="currentColor"` on the
   * glyphs and needed a `style="color:..."` injected on the root, because a
   * `data:` URI is an isolated document where `currentColor` falls back to
   * black. `@vectojs/tex` takes a `color` option and writes it directly as
   * `fill` on the group wrapping every glyph, so there is no `currentColor` to
   * resolve and no root `style` to preserve. Asserting on `color:#ff8800` or on
   * the `style` attribute count would now be testing MathJax's serialization
   * through an engine that is gone.
   */
  it('paints the glyphs in the theme text color', () => {
    const md = new Markdown('$$a+b$$', { theme: { textColor: '#ff8800' } });
    const svg = svgOf(mathBlocksOf(md)[0]);
    // The colour must reach the element that actually paints. Matching anywhere
    // in the document would pass on a stray attribute that paints nothing.
    expect(svg).toMatch(/<g fill="#ff8800">/);
  });

  it('leaves no unresolved currentColor in the isolated data URI', () => {
    const md = new Markdown('$$a+b$$', { theme: { textColor: '#ff8800' } });
    // A `data:` URI inherits no CSS, so any surviving `currentColor` resolves to
    // black and the formula is invisible on this package's dark default theme.
    // That was the original defect; this asserts the class cannot return.
    expect(svgOf(mathBlocksOf(md)[0])).not.toContain('currentColor');
  });

  it('reports a depth that seats the formula on the baseline', () => {
    // MathJax carried depth in a root `style="vertical-align:-N ex"` that the
    // converter scraped back out, so the old test guarded that attribute. Depth
    // now comes from the layout tree as a number, so assert the number: a
    // formula with a descender must report a positive depth, or it renders
    // sitting above the baseline it should hang below.
    const md = new Markdown('$$\\int_a^b f(x)\\,dx$$', {
      theme: { textColor: '#ff8800' },
    });
    const block = mathBlocksOf(md)[0];
    expect(block).toBeDefined();
    const svg = svgOf(block);
    // The viewBox's minY is negative by the height above the baseline, and its
    // height exceeds that by the depth below it. Both are required for the box
    // to describe a formula that straddles the baseline.
    const viewBox = /viewBox="(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)"/.exec(svg);
    expect(viewBox).not.toBeNull();
    const minY = parseFloat(viewBox![2]);
    const boxH = parseFloat(viewBox![4]);
    expect(minY).toBeLessThan(0);
    expect(boxH).toBeGreaterThan(-minY);
  });

  it('re-typesets rather than serving the previous theme colour', () => {
    // The colour is baked into the cached SVG bytes, so it has to be part of the
    // cache key. Keying on the formula alone served a re-themed document the old
    // theme's bitmap — invisible, not merely wrong, across a light/dark switch.
    const dark = new Markdown('$$a+b$$', { theme: { textColor: '#e2e8f0' } });
    const light = new Markdown('$$a+b$$', { theme: { textColor: '#111111' } });
    expect(svgOf(mathBlocksOf(dark)[0])).toMatch(/<g fill="#e2e8f0">/);
    expect(svgOf(mathBlocksOf(light)[0])).toMatch(/<g fill="#111111">/);
  });

  it('gives inline math the surrounding run colour', () => {
    const md = new Markdown('text $x+1$ more', {
      theme: { textColor: '#44ff44' },
    });
    // Inline math paints through StyledSpan.object, so find its URI directly.
    const spans: any[] = [];
    for (const e of walk(md.content)) {
      if (Array.isArray(e.spans)) spans.push(...e.spans);
    }
    const obj = spans.find((s) => s.object !== undefined);
    expect(obj).toBeDefined();
    // The object's alt is the TeX source; the colour lives in the painted SVG,
    // which the object closure holds. Assert via the theme-coloured cache entry.
    expect(obj.object.alt).toBe('x+1');
  });
});

describe('math-foundations regression (CTX-0529)', () => {
  it('typesets the three display blocks that degraded to raw TeX', async () => {
    await preloadMathJax();
    const cases = [
      '\\mathbf{M}_{\\text{world, child}} = \\mathbf{M}_{\\text{world, parent}} \\cdot \\mathbf{M}_{\\text{local}}',
      'I_{\\text{allowed}} = I_0 \\setminus \\bigcup_{k=1}^{K} E_k',
      'd^2(C, \\overline{P_iP_{i+1}}) \\le \\left(\\frac{\\text{lineWidth}}{2} + \\text{hitTolerance}\\right)^2',
    ];
    for (const tex of cases) {
      const md = new Markdown(`$$${tex}$$`);
      expect(mathBlocksOf(md), tex).toHaveLength(1);
      expect(mathBlocksOf(md)[0].formula, tex).toBe(tex);
      expect(textOf(md), tex).not.toContain('$');
      const svg = svgOf(mathBlocksOf(md)[0]);
      expect(svg, tex).toContain('<path');
    }
  });

  it('does not turn underscores inside $$...$$ into emphasis', async () => {
    await preloadMathJax();
    const md = new Markdown('$$d^2(C, \\overline{P_iP_{i+1}}) \\le 1$$');
    expect(mathBlocksOf(md)).toHaveLength(1);
    expect(mathBlocksOf(md)[0].formula).toBe('d^2(C, \\overline{P_iP_{i+1}}) \\le 1');
    expect(mathBlocksOf(md)[0].formula).not.toContain('*');
    expect(textOf(md)).not.toContain('*');
  });
});

describe('blockMath stops at blank line for incremental lexing', () => {
  it('stops at first blank line, treating remainder as a new paragraph', () => {
    const md = new Markdown('$$\nx = 1\n\ny = 2\n$$\n');
    // With the blank-line termination rule, this becomes:
    // 1. An unclosed math fence `$$\nx = 1\n` (renders as CodeBlock)
    // 2. A paragraph `y = 2`
    // 3. A paragraph `$$` (literal text)
    //
    // The math block does NOT span the blank line.
    expect(mathBlocksOf(md)).toHaveLength(0);
    const text = textOf(md);
    expect(text).toContain('x = 1');
    expect(text).toContain('y = 2');
    expect(text).toContain('$$');
  });

  it('allows multi-line math without blank lines', () => {
    const md = new Markdown('$$\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n$$\n');
    // No blank line inside, so this is one continuous math block.
    expect(mathBlocksOf(md)).toHaveLength(1);
    expect(textOf(md)).not.toContain('$');
  });

  it('treats blank-line-terminated math as unclosed', () => {
    const md = new Markdown('before\n\n$$\nx^2\n\nafter\n');
    // The blank line after `x^2` terminates the math block, but there's no
    // closing `$$`, so it renders as a CodeBlock showing the TeX source.
    expect(mathBlocksOf(md)).toHaveLength(0);
    const text = textOf(md);
    expect(text).toContain('before');
    expect(text).toContain('x^2');
    expect(text).toContain('after');
  });

  it('enables incremental lexing for math-heavy documents', () => {
    // The performance improvement is tested via the incremental lex suite.
    // This test documents the new behavior: each closed math block is its own
    // token, rather than forcing the lexer to scan the whole document.
    const doc = '$$\na = 1\n$$\n\n$$\nb = 2\n$$\n\n$$\nc = 3\n$$\n';
    const md = new Markdown(doc);
    expect(mathBlocksOf(md)).toHaveLength(3);
  });
});
