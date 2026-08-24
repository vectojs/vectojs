import { describe, expect, it, vi } from 'vitest';
import { getGlyph, UNITS_PER_EM } from '../src/emit/glyphTable';
import { emitSVG } from '../src/emit/svg';
import { layout } from '../src/layout';
import { Span, SymbolNode } from '../src/kernel/domTree';
import type { HtmlDomNode } from '../src/kernel/domTree';

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

  it('phantom content keeps its advance but places no ink', () => {
    // \mathstrut is \vphantom{(}, so the phantom paren shares the x's origin.
    const out = emitSVG(layout('\\mathstrut x'));

    expect(out.placements.map((p) => p.char)).toEqual(['x']);
    expect(out.width).toBeCloseTo(0.572, 3);

    // A phantom occupies exactly the advance of its visible twin.
    const phantom = emitSVG(layout('\\phantom{x}+x'));
    const visible = emitSVG(layout('x+x'));
    expect(phantom.width).toBeCloseTo(visible.width, 5);
    expect(phantom.placements.map((p) => p.char)).toEqual(['+', 'x']);
  });

  it('resolves TeX colour onto grouped fills', () => {
    // The default output has exactly the one root fill.
    expect(emitSVG(layout('x')).svg.match(/fill=/g) ?? []).toHaveLength(1);

    const colored = emitSVG(layout('\\color{red}x'));
    expect(colored.svg).toContain('fill="red"');
    expect(colored.svg.match(/fill=/g) ?? []).toHaveLength(2);

    // Two consecutive same-colour glyphs share one nested group.
    const textcolor = emitSVG(layout('\\textcolor{blue}{xy}'));
    expect(textcolor.svg).toContain('fill="blue"');
    expect(textcolor.svg.match(/fill=/g) ?? []).toHaveLength(2);
  });

  it('emits underline and overline rules as full-width rects', () => {
    const under = emitSVG(layout('\\underline{x}'));
    const rects = under.svg.match(/<rect /g) ?? [];
    expect(rects).toHaveLength(1);

    // The rule spans the same advance the underlined content occupies.
    const m = /<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"\/>/.exec(
      under.svg,
    );
    expect(m).not.toBeNull();
    expect(Number(m![3]) / UNITS_PER_EM).toBeCloseTo(under.width, 3);

    expect(emitSVG(layout('\\overline{x}')).svg.match(/<rect /g) ?? []).toHaveLength(1);
  });

  it('centres limit rows over the operator', () => {
    // In display style \sum gets `op-limits`, whose vlist rows are centred
    // against the widest row (the operator itself), so the narrow subscript
    // `n` sits under the middle of the ∑ glyph rather than at its left edge.
    const out = emitSVG(layout('\\sum_{i=1}^n i', { displayMode: true }));
    const sum = out.placements.find((p) => p.char === '∑');
    const n = out.placements.find((p) => p.char === 'n');
    expect(sum).toBeDefined();
    expect(n).toBeDefined();

    const sumW = (getGlyph(sum!.font, sum!.code)!.advance / UNITS_PER_EM) * sum!.scale;
    const nW = (getGlyph(n!.font, n!.code)!.advance / UNITS_PER_EM) * n!.scale;
    expect(n!.x + nW / 2).toBeCloseTo(sum!.x + sumW / 2, 3);

    // The operator row is the widest, so it stays put.
    expect(sum!.x).toBeCloseTo(0, 3);
  });

  it('positions lap ink per class: rlap at the anchor, llap left, clap centred', () => {
    // \llap/\rlap/\clap expand to \math*lap{\textrm{#1}} (macros.ts:273-275),
    // so the content is a text-roman `y`; its advance is measured from the
    // same formula alone.
    const yWidth = emitSVG(layout('\\textrm{y}')).width;
    const anchor = emitSVG(layout('x')).width;

    const rlap = emitSVG(layout('x\\rlap{y}'));
    const llap = emitSVG(layout('x\\llap{y}'));
    const clap = emitSVG(layout('x\\clap{y}'));

    const rY = rlap.placements.find((p) => p.char === 'y');
    const lY = llap.placements.find((p) => p.char === 'y');
    const cY = clap.placements.find((p) => p.char === 'y');
    expect(rY).toBeDefined();
    expect(lY).toBeDefined();
    expect(cY).toBeDefined();

    // `.rlap > .katex-inner { left: 0 }` starts ink at the anchor;
    // `.llap > .katex-inner { right: 0 }` ends it there; `.clap > .katex-inner
    // > span { margin-left: -50% }` centres it (katex.scss:308-320).
    expect(rY!.x).toBeCloseTo(anchor, 3);
    expect(lY!.x).toBeCloseTo(anchor - yWidth, 3);
    expect(cY!.x).toBeCloseTo(anchor - yWidth / 2, 3);

    // A lap occupies no advance width in any direction.
    expect(rlap.width).toBeCloseTo(anchor, 3);
    expect(llap.width).toBeCloseTo(anchor, 3);
    expect(clap.width).toBeCloseTo(anchor, 3);
  });

  it('expands the viewBox leftward for lap ink outside the origin', () => {
    // `\llap{abc}` is wider than the following `x`, so its ink starts left of
    // x=0 and the layout-box viewBox would cut it off.
    const out = emitSVG(layout('\\llap{abc}x'));
    const m = /viewBox="([^"]+)"/.exec(out.svg);
    expect(m).not.toBeNull();
    const [minX] = m![1].split(' ').map(Number);
    expect(minX).toBeLessThan(-100); // far more than the -50 pad
    expect(out.width).toBeCloseTo(emitSVG(layout('x')).width, 3);
  });

  it('expands the viewBox to ink when \\smash zeroes height/depth', () => {
    // \smash zeroes the box but its children keep full size, so the fraction
    // ink extends far above and below the baseline while the layout box is
    // zero-height: the union viewBox must grow to include the placements.
    const out = emitSVG(layout('\\smash{\\frac{1}{2}}'));

    expect(out.height).toBe(0);
    expect(out.depth).toBe(0);

    const m = /viewBox="([^"]+)"/.exec(out.svg);
    expect(m).not.toBeNull();
    const [, minY, , h] = m![1].split(' ').map(Number);
    expect(minY).toBeLessThan(-400); // numerator ink, not the -50 pad floor
    expect(h).toBeGreaterThan(400); // fraction extent, far past the 2*pad floor
  });

  it('escapes attribute-breaking characters in colours', () => {
    // `\color{...}` arguments are parse-time validated against a strict colour
    // regex (Parser.ts parseColorGroup), but the `color` OPTION is interpolated
    // into attributes unchecked — theme-derived today, future user-derived
    // callers tomorrow. A `"` must not terminate the attribute early.
    const themed = emitSVG(layout('x'), { color: 'a<b&c"d' });
    expect(themed.svg).not.toContain('a<b&c"d');
    expect(themed.svg).toContain('fill="a&lt;b&amp;c&quot;d"');

    // The option colour also lands on `\cancel` line strokes, which need the
    // same treatment.
    const cancel = emitSVG(layout('\\cancel{x}'), { color: 'a"b' });
    expect(cancel.svg).not.toContain('stroke="a"b"');
    expect(cancel.svg).toContain('stroke="a&quot;b"');

    // Escaping is a no-op on every valid colour, so normal themes are
    // unchanged.
    expect(emitSVG(layout('x'), { color: 'rgb(1, 2, 3)' }).svg).toContain('fill="rgb(1, 2, 3)"');
  });

  it('keeps the viewBox finite when a missing glyph has no metrics either', () => {
    // The metrics table covers every character KaTeX lays out, but emit must
    // survive its own defensive path: when BOTH the outline table and
    // `getCharacterMetrics` miss, the old `(m?.width ?? node.width)` fallback
    // read the SymbolNode's width — and a non-finite value there poisoned
    // penX and the whole viewBox. A hand-built tree forces that path
    // deterministically (no kernel input produces it): the constructor
    // coerces falsy widths to 0 (`width || 0`), so the poison value is
    // assigned after construction.
    const symbol = new SymbolNode('\uE000', 0.5, 0, 0, 0);
    symbol.width = Number.NaN;
    const tree = new Span<HtmlDomNode>([], [symbol], undefined);
    tree.height = 0.5;
    tree.depth = 0;

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const uE000Warns = () => warn.mock.calls.filter((args) => String(args[0]).includes('U+E000'));
    try {
      const out = emitSVG(tree);

      expect(out.width).toBe(0); // advance fell back to 0, not NaN
      expect(Number.isFinite(out.height)).toBe(true);
      expect(Number.isFinite(out.depth)).toBe(true);
      const [, , w, h] = /viewBox="([^"]+)"/.exec(out.svg)![1].split(' ').map(Number);
      expect(w).toBeGreaterThan(0); // pad-only box, still finite
      expect(h).toBeGreaterThan(0);
      expect(out.missing).toEqual(['Main-Regular/U+E000']);
      expect(uE000Warns()).toHaveLength(1);

      // The warn fires once per unique miss even when the glyph repeats.
      warn.mockClear();
      const twin = new SymbolNode('\uE000', 0.5, 0, 0, 0);
      twin.width = Number.NaN;
      const repeated = new Span<HtmlDomNode>([], [symbol, twin], undefined);
      repeated.height = 0.5;
      emitSVG(repeated);
      expect(uE000Warns()).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('\\boxed and \\fbox draw their border as four edge rects', () => {
    for (const tex of ['\\boxed{x^2}', '\\fbox{x}']) {
      const out = emitSVG(layout(tex));
      // One rect per border edge: top, bottom, left, right.
      const rects = out.svg.match(/<rect /g) ?? [];
      expect(rects.length, tex).toBe(4);

      // The edges resolve against the enclosing vlist extent: every edge
      // lands inside a viewBox wide enough for the content plus borders.
      const [, , w] = /viewBox="([^"]+)"/.exec(out.svg)![1].split(' ').map(Number);
      expect(w).toBeGreaterThan(100);

      // Border thickness comes from `borderWidth` (\fboxrule = 0.04em), so
      // every edge is at least one axis thin: 40 SVG units at scale 1.
      const dims = [...out.svg.matchAll(/<rect [^>]*width="([\d.]+)" height="([\d.]+)"\/>/g)].map(
        (m) => Math.min(Number(m[1]), Number(m[2])),
      );
      expect(dims.length, tex).toBe(4);
      expect(
        dims.every((thin) => thin > 0 && thin <= 40),
        tex,
      ).toBe(true);
    }
  });

  it('\\angl draws only its top and right border edges', () => {
    const out = emitSVG(layout('\\angl{x}'));

    // `.angl { border-top/right: 0.049em solid }` (katex.scss:601-607); no
    // bottom or left edge.
    const rects = out.svg.match(/<rect /g) ?? [];
    expect(rects.length).toBe(2);
  });

  it('\\colorbox paints its background behind the glyphs', () => {
    const out = emitSVG(layout('\\colorbox{red}{x}'));

    // No border was requested, so the background fill is the only rect ink.
    expect((out.svg.match(/<rect /g) ?? []).length).toBe(1);
    // Background must be painted before the glyph paths it sits behind.
    expect(out.svg.indexOf('fill="red"')).toBeGreaterThan(-1);
    expect(out.svg.indexOf('fill="red"')).toBeLessThan(out.svg.indexOf('<path'));
  });

  it('\\fcolorbox paints a blue background behind and a red frame over', () => {
    const out = emitSVG(layout('\\fcolorbox{red}{blue}{x}'));

    expect(out.svg.indexOf('fill="blue"')).toBeGreaterThan(-1);
    expect(out.svg.indexOf('fill="blue"')).toBeLessThan(out.svg.indexOf('<path'));
    // The frame colour appears after the glyphs: borders are edge rects in
    // the foreground layer.
    expect(out.svg.indexOf('fill="red"')).toBeGreaterThan(-1);
    expect(out.svg.indexOf('fill="red"')).toBeGreaterThan(out.svg.indexOf('<path'));
  });

  it('draws array vertical rules ({c|c}) as vertical lines', () => {
    const out = emitSVG(layout('\\begin{array}{c|c} a & b \\\\ \\hline c & d \\end{array}'));

    // The \hline stays a full-width rect; each `|` separator adds one
    // vertical line spanning the table height.
    expect((out.svg.match(/<rect /g) ?? []).length).toBe(1);
    const lines = [...out.svg.matchAll(/<line [^>]+>/g)].map((m) => m[0]);
    expect(lines.length).toBe(1);

    // Vertical: x1 === x2, and the rule spans both rows plus the inter-row
    // gap, i.e. more than a single glyph's ascent (1 em = 1000 units).
    const [, x1, y1, x2, y2] = lines[0]!
      .match(/x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)" y2="([-\d.]+)"/)!
      .map(Number);
    expect(x1).toBe(x2);
    expect(y2 - y1).toBeGreaterThan(1000);
  });

  it('treats multi-piece stretchy overlays as zero-advance', () => {
    // Each overlay piece declares `width: "400em"`, but in CSS the pieces are
    // absolutely positioned percentage overlays contributing no advance; the
    // construct is as wide as the content it decorates.
    const cases: Array<[string, string]> = [
      ['\\overbrace{x+y}', 'x+y'],
      ['\\underbrace{x+y}', 'x+y'],
      ['\\overleftrightarrow{xy}', 'xy'],
    ];
    for (const [tex, body] of cases) {
      const out = emitSVG(layout(tex));
      const bare = emitSVG(layout(body));
      expect(out.width, tex).toBeCloseTo(bare.width, 3);
      // The ink still exists and stays within the content extent.
      expect(out.svg).toContain('<path');
      const [, , vw] = /viewBox="([^"]+)"/.exec(out.svg)![1].split(' ').map(Number);
      expect(vw, tex).toBeLessThan(bare.width * UNITS_PER_EM + UNITS_PER_EM);
    }
  });

  it('slices multi-piece stretchy ink across its fraction windows', () => {
    // \overbrace's three pieces draw the left hook, the middle span and the
    // right hook of the same 400em-wide path; each must be clipped to its own
    // quarter-window of the content extent.
    const out = emitSVG(layout('\\overbrace{x+y}'));
    const paths = [...out.svg.matchAll(/<path[^>]*clip-path[^>]*d="/g)];
    expect(paths.length).toBe(3);

    const clips = [
      ...out.svg.matchAll(/<clipPath[^>]*><rect x="([-\d.]+)" y="([^"]+)" width="([\d.]+)"/g),
    ].map((m) => ({ x: Number(m[1]), w: Number(m[3]) }));
    clips.sort((a, b) => a.x - b.x);
    expect(clips.length).toBe(3);
    // Left window starts at the origin, middle at ~25%, right ends together.
    expect(clips[0]!.x).toBeLessThan(clips[1]!.x);
    expect(clips[1]!.x).toBeLessThan(clips[2]!.x);
    // The three windows tile the extent without a gap.
    expect(clips[0]!.w).toBeGreaterThan(0);
    expect(clips[1]!.w).toBeGreaterThan(clips[0]!.w);
  });

  it('\\phase advances its content extent, not its 400em tail', () => {
    const out = emitSVG(layout('\\phase{-120}'));
    const bare = emitSVG(layout('-120'));

    // The angle SVG declares `width: "400em"`; `.hide-tail` without an inline
    // extent clips it to the content, so the advance is the body plus the
    // reserved left pad — not four hundred em.
    expect(out.width).toBeLessThan(5);
    expect(out.width).toBeGreaterThan(bare.width);

    // The clipped overlay ink still exists.
    expect(out.svg).toContain('clip-path');
    expect(out.svg).toContain('<path');
  });

  it('applies class-carried horizontal padding', () => {
    // `.x-arrow-pad { padding: 0 0.5em }` sits on the label's *sizing* span
    // (`reset-size6.size3` = ×0.7), so the padding scales with it: two
    // 0.35em sides on top of the previously-measured 5.8576em. This
    // deliberately deviates from #696's "≈6.858" estimate, which forgot that
    // em paddings resolve against the element's own font-size.
    const arrow = emitSVG(layout('\\xrightarrow{\\text{very long label here}}'));
    expect(arrow.width).toBeCloseTo(6.5576, 3);

    // `.cancel-pad` widens the ink window by 0.4em while `.cancel-lap`'s
    // negative margins cancel the advance, exactly as the CSS pair behaves.
    expect(emitSVG(layout('\\cancel{xy}')).width).toBeCloseTo(1.0979, 3);

    // `.boxpad` pads boxed content; the border edges resolve across it.
    const boxed = emitSVG(layout('\\boxed{x}'));
    expect(boxed.width).toBeCloseTo(emitSVG(layout('x')).width + 0.6, 3);
  });
});
