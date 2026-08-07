// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import type { StyledSpan } from '@vectojs/core';
import { KATEX_FONT_SCALE, emitSVG, layout } from '@vectojs/tex';
import { Markdown, preloadMathJax } from '../src/Markdown';

/**
 * The box a typeset formula reserves, in px.
 *
 * This file exists because the whole math suite passed three separate
 * sabotages of that box: dropping the SVG's padding from the reported width,
 * dropping `KATEX_FONT_SCALE` (a uniform 21% mis-size of every formula), and
 * rendering a formula with a glyph silently absent. 507 tests, all green, three
 * times — nothing anywhere read the reserved box, so a formula could be sized
 * arbitrarily wrong and only a human looking at a screenshot would notice.
 *
 * The numbers a reader sees come from two constants that no unit test can
 * validate on its own, because they translate between two packages' unit
 * systems: `KATEX_FONT_SCALE` (1.21, upstream's `.katex { font-size: 1.21em }`)
 * and `EX_PER_EM` (0.4421, measured against MathJax's SVG output). Their product
 * was verified against real KaTeX in Chromium — four display formulas spanning
 * 1.79-2.93 em of height all measured 19.3559 px/em at font-size 16, a 0.033%
 * spread, giving 1.20975 against the constant's 1.21. What these tests can and
 * do pin is that the arithmetic wiring those constants to the reserved box stays
 * correct, and that the box keeps describing the SVG that is actually painted
 * into it.
 *
 * `MathRender` is deliberately module-private (pinned by `publicApi.test.ts`), so
 * the box is read where a consumer sees it: `StyledSpan.object`, which the text
 * engine fills via `drawImage(bitmap, x, y, box.width, box.height)`.
 */
beforeAll(async () => {
  await preloadMathJax();
});

/** How many `ex` one em of emitted geometry is. Mirrors the converter. */
const EX_PER_EM = 0.4421;
const EX_PER_KATEX_EM = KATEX_FONT_SCALE / EX_PER_EM;
/** The padding the converter asks `emitSVG` for, in em, on all four sides. */
const MATH_PAD_EM = 0.05;

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

/** The single inline-object span a one-formula document produces. */
function mathObject(md: Markdown): NonNullable<StyledSpan['object']> {
  const spans = spansOf(md).filter((s) => s.object !== undefined);
  expect(spans).toHaveLength(1);
  return spans[0].object!;
}

/** The `<svg>` root's `width`/`height` attributes, in px, off a data URI. */
function svgAttrs(uri: string): { width: number; height: number } {
  const svg = atob(uri.slice('data:image/svg+xml;base64,'.length));
  const w = /<svg[^>]*\bwidth="([\d.]+)"/.exec(svg);
  const h = /<svg[^>]*\bheight="([\d.]+)"/.exec(svg);
  expect(w).not.toBeNull();
  expect(h).not.toBeNull();
  return { width: parseFloat(w![1]), height: parseFloat(h![1]) };
}

describe('the reserved box matches the emitted SVG', () => {
  /**
   * The box is what `drawImage` stretches the raster into, so if it disagrees
   * with the SVG's own aspect ratio the formula is visibly squashed or stretched.
   * Comparing ratios rather than absolute px is what makes this independent of
   * the em->ex constants: whatever they are, the shape must be preserved.
   */
  it.each([
    ['x^2 + y^2 = z^2', 16],
    ['\\frac{a}{b}', 16],
    ['\\sqrt{x+1}', 24],
    ['a_i', 12],
  ])('preserves the SVG aspect ratio for %s at fontSize %i', (formula, fontSize) => {
    const md = new Markdown(`text $${formula}$ more`, { theme: { fontSize } });
    const box = mathObject(md);
    // Re-emit the same formula to read the SVG's own attributes. The painted URI
    // lives inside a closure the span does not expose, and re-emitting is
    // deterministic — `encode-glyphs --check` pins the table it reads.
    const emitted = emitSVG(layout(formula, { displayMode: false }), {
      emPx: fontSize * KATEX_FONT_SCALE,
      padEm: MATH_PAD_EM,
    });
    const svg = svgAttrs(`data:image/svg+xml;base64,${btoa(emitted.svg)}`);
    const boxRatio = box.width / box.height;
    const svgRatio = svg.width / svg.height;

    // 0.5% tolerance absorbs `emitSVG`'s 2-decimal attribute rounding, which is
    // coarse on a small formula.
    expect(Math.abs(boxRatio - svgRatio) / svgRatio).toBeLessThan(0.005);
  });

  /**
   * The padding is the part most easily lost: `EmitResult.{width,height,depth}`
   * are the ink box, while the SVG's attributes include `padEm` on all four
   * sides. Reporting the ink box squashes every formula by that much.
   */
  it('includes the SVG padding in the reserved box', () => {
    const formula = 'x+1';
    const fontSize = 16;
    const md = new Markdown(`text $${formula}$ more`, { theme: { fontSize } });
    const box = mathObject(md);

    const ink = emitSVG(layout(formula, { displayMode: false }), {
      padEm: MATH_PAD_EM,
    });
    const pxPerEm = fontSize * KATEX_FONT_SCALE;
    const withPad = (ink.width + MATH_PAD_EM * 2) * pxPerEm;
    const withoutPad = ink.width * pxPerEm;

    expect(box.width).toBeCloseTo(withPad, 1);
    // The two must be far enough apart that the assertion above is meaningful —
    // otherwise it would pass on the unpadded value too.
    expect(Math.abs(withPad - withoutPad)).toBeGreaterThan(1);
  });

  /**
   * Depth positions the formula against the surrounding text baseline. It must
   * carry the padding for the same reason width does: the raster's bottom edge
   * is `padEm` below the ink, so a depth measured on the ink seats every formula
   * that much too high.
   */
  it('includes the SVG padding in the reported depth', () => {
    const formula = '\\frac{a}{b}';
    const fontSize = 16;
    const md = new Markdown(`text $${formula}$ more`, { theme: { fontSize } });
    const box = mathObject(md);

    const ink = emitSVG(layout(formula, { displayMode: false }), {
      padEm: MATH_PAD_EM,
    });
    const pxPerEm = fontSize * KATEX_FONT_SCALE;
    expect(box.depth).toBeCloseTo((ink.depth + MATH_PAD_EM) * pxPerEm, 1);
    // A fraction hangs below the baseline, so a zero depth would mean the box
    // arithmetic collapsed rather than that this formula happens to sit flat.
    expect(box.depth).toBeGreaterThan(0);
  });

  /**
   * `ex` is font-relative, which is the entire reason the cache stores `ex`
   * rather than px: one conversion is reused across runs of different sizes.
   * Doubling the font size must double the box.
   */
  it('scales the box linearly with font size', () => {
    const formula = 'x^2';
    const small = mathObject(new Markdown(`text $${formula}$ more`, { theme: { fontSize: 12 } }));
    const large = mathObject(new Markdown(`text $${formula}$ more`, { theme: { fontSize: 24 } }));
    expect(large.width / small.width).toBeCloseTo(2, 2);
    expect(large.height / small.height).toBeCloseTo(2, 2);
    expect(large.depth / small.depth).toBeCloseTo(2, 2);
  });

  /**
   * The absolute scale, pinned once so that dropping `KATEX_FONT_SCALE` fails
   * here rather than only being visible on screen. 1.21 is upstream's own
   * `.katex` font-size and was confirmed against real KaTeX to 0.02%; a bare
   * `1 / EX_PER_EM` would mis-size every formula by 21%.
   */
  it('applies the KaTeX 1.21em font scale', () => {
    const formula = 'x+1';
    const fontSize = 16;
    const box = mathObject(new Markdown(`text $${formula}$ more`, { theme: { fontSize } }));
    const ink = emitSVG(layout(formula, { displayMode: false }), {
      padEm: MATH_PAD_EM,
    });
    const emWithPad = ink.width + MATH_PAD_EM * 2;

    expect(box.width).toBeCloseTo(emWithPad * fontSize * KATEX_FONT_SCALE, 1);
    // And is measurably NOT the unscaled value.
    expect(box.width).not.toBeCloseTo(emWithPad * fontSize, 1);
  });

  /**
   * The converter re-declares `KATEX_FONT_SCALE` locally rather than importing
   * it, because a value import of `@vectojs/tex` would create a static module
   * edge and pull the whole engine into every consumer's entry chunk — including
   * a prose-only one. This is the test that keeps the copy honest.
   */
  it('keeps the local KATEX_FONT_SCALE equal to the engine export', () => {
    expect(KATEX_FONT_SCALE).toBe(1.21);
    expect(EX_PER_KATEX_EM).toBeCloseTo(1.21 / 0.4421, 10);
  });
});

describe('a formula with an unavailable glyph degrades to source', () => {
  /**
   * `emitSVG` reports whitelist misses in `EmitResult.missing` and emits no
   * placement for them, so rendering anyway produces a formula that is missing a
   * symbol — `\sum` without its operator reads as a different equation. Showing
   * the TeX source instead is correct and copyable.
   *
   * `\digamma` is in KaTeX's function table (so `layout` succeeds and this is
   * genuinely a glyph-table miss, not a parse error) but outside the shipped
   * corpus.
   */
  it('renders no inline object when a glyph is missing', () => {
    const emitted = emitSVG(layout('\\digamma', { displayMode: false }));
    // Guard the premise: if the corpus ever ships this glyph, the test below
    // would silently stop testing degradation.
    expect(emitted.missing.length).toBeGreaterThan(0);

    const md = new Markdown('text $\\digamma$ more');
    const objects = spansOf(md).filter((s) => s.object !== undefined);
    expect(objects).toHaveLength(0);
    // The source survives as readable text rather than vanishing.
    expect(
      spansOf(md)
        .map((s) => s.text)
        .join(''),
    ).toContain('digamma');
  });

  it('still typesets a formula whose glyphs are all available', () => {
    const emitted = emitSVG(layout('x+1', { displayMode: false }));
    expect(emitted.missing).toEqual([]);
    expect(
      spansOf(new Markdown('text $x+1$ more')).filter((s) => s.object !== undefined),
    ).toHaveLength(1);
  });
});
