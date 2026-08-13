import { describe, expect, it } from 'vitest';
import { emitSVG } from '../src/emit/svg';
import { layout } from '../src/layout';

/**
 * Phase 1 acceptance: one TeX string -> one self-contained SVG string.
 *
 * "Self-contained" is the load-bearing property, not a stylistic preference.
 * `SVGEntity` rasterizes via `data URI -> Image -> createImageBitmap ->
 * drawImage`, and an `Image` loaded from a data URI resolves **no** external
 * references and inherits **no** page CSS. So a `<text>` element, a
 * `font-family`, a `url(...)`, or an `xlink:href` to anything outside the
 * document would each render as either nothing or a fallback glyph.
 */
describe('emitSVG', () => {
  it('renders a single symbol as outline paths', () => {
    const svg = emitSVG(layout('x'));

    expect(svg.svg).toContain('<svg');
    expect(svg.svg).toContain('</svg>');
    expect(svg.svg).toContain('<path');
  });

  it('carries its own outlines: no text, no font, no external reference', () => {
    for (const tex of ['x', 'x^2 + y^2 = z^2', '\\frac{a}{b}', '\\sqrt{x}']) {
      const { svg } = emitSVG(layout(tex));

      expect(svg, tex).not.toContain('<text');
      expect(svg, tex).not.toContain('font-family');
      expect(svg, tex).not.toContain('@font-face');
      expect(svg, tex).not.toContain('xlink:href');

      // Only *external* references break inside a data URI. A same-document
      // fragment such as `url(#c0)` for a clipPath, or `href="#g0"` on a
      // `<use>`, resolves normally — `\sqrt` needs a clipPath because KaTeX
      // emits a 400em radical and relies on `overflow: hidden` to trim it.
      // Banning `url(` outright therefore rejects correct output; what must be
      // absent is a scheme or a path.
      const external = svg.match(/url\((?!#)[^)]*\)|href="(?!#)[^"]*"/g) ?? [];
      expect(external, `${tex} must not reference anything outside itself`).toEqual([]);
    }
  });

  it('reports the layout height and depth it was given', () => {
    const tree = layout('x^2 + y^2 = z^2');
    const out = emitSVG(tree);

    expect(out.height).toBeCloseTo(tree.height, 5);
    expect(out.depth).toBeCloseTo(tree.depth, 5);
    expect(out.width).toBeGreaterThan(0);
  });

  /**
   * Pinned to the advance width KaTeX's own `fontMetricsData` reports, which is
   * an independent source from the TTF the glyph table was extracted from.
   *
   * A relative assertion (`wider.width > narrow.width * 2`) is worthless here:
   * it passes when *both* are zero, so it cannot tell a working emitter from
   * one that never advances the pen. Verified by sabotage — replacing the pen
   * advance with a no-op left the relative form green and this form red.
   */
  it('advances by the glyph advance width', () => {
    // Math-Italic `x`: metrics width 0.57153, TTF advance 572/1000. The 0.5
    // font-unit gap is `hmtx` integer rounding, which the browser sees too.
    expect(emitSVG(layout('x')).width).toBeCloseTo(0.572, 3);

    // A second identical glyph must add exactly one more advance. This catches
    // both a dead advance and a double-counted one.
    const one = emitSVG(layout('x')).width;
    const two = emitSVG(layout('xx')).width;
    expect(two - one).toBeCloseTo(0.572, 3);
  });

  it('accumulates advance across a formula', () => {
    // `x + x + x`: three Math-Italic x plus two Main-Regular + (0.778 each),
    // plus four medium binary-operator spaces of 0.2222em.
    const expected = 3 * 0.572 + 2 * 0.778 + 4 * 0.2222;
    expect(emitSVG(layout('x + x + x')).width).toBeCloseTo(expected, 3);
  });

  it('emits a well-formed viewBox covering height + depth', () => {
    const out = emitSVG(layout('x^2'));
    const m = /viewBox="([^"]+)"/.exec(out.svg);

    expect(m).not.toBeNull();
    const [minX, minY, w, h] = m![1].split(' ').map(Number);
    expect(Number.isFinite(minX)).toBe(true);
    expect(Number.isFinite(minY)).toBe(true);
    expect(w).toBeGreaterThan(0);
    expect(h).toBeGreaterThan(0);
  });

  it('\\cancel advances by the content width and draws a stroked diagonal', () => {
    // `\cancel`'s SVG is `width: 100%` — an overlay that occupies no advance.
    // The pen must advance by the cancelled content (a single Math-Italic x),
    // not by the 100em that `parseFloat("100%")` used to yield.
    const out = emitSVG(layout('\\cancel{x}'));
    expect(out.width).toBeCloseTo(0.572, 3);

    // A diagonal stroke, not a filled rectangle covering the formula.
    expect(out.svg).toContain('<line');
    expect(out.svg).not.toContain('<rect');
    expect(out.missing).toEqual([]);
  });

  it('\\cancel variants draw the correct diagonals', () => {
    // \cancel → forward slash; \bcancel → back slash; \xcancel → both.
    const cancel = emitSVG(layout('\\cancel{x}'));
    const bcancel = emitSVG(layout('\\bcancel{x}'));
    const xcancel = emitSVG(layout('\\xcancel{x}'));
    const lineCount = (svg: string) => (svg.match(/<line /g) ?? []).length;

    expect(lineCount(cancel.svg)).toBe(1);
    expect(lineCount(bcancel.svg)).toBe(1);
    expect(lineCount(xcancel.svg)).toBe(2);

    // Every variant still advances by the content width, never 100em.
    for (const out of [cancel, bcancel, xcancel]) {
      expect(out.width).toBeCloseTo(0.572, 3);
    }
  });
});
