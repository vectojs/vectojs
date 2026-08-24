import {
  contentLineInHint,
  type ContentProjectionHint,
  A11yAttributes,
  EMPTY_GLYPH_ATLAS,
  IRenderer,
  LayoutEngine,
  type GlyphMeasurer,
  type LayoutNode,
  type PreparedText,
  createMetricsMeasurer,
} from '@vectojs/core';
import { UIComponent } from './UIComponent';
import { familyOf, fontSizePx, getSharedMeasuringContext, measureText } from './measure';
import type { ContentProjection, ContentProjectionRun } from '@vectojs/core';

/** Construction options for {@link Text}. */
export interface TextOptions {
  /** CSS font shorthand. Default `'16px sans-serif'`. */
  font?: string;
  /** Fill color. Default `'#e2e8f0'`. */
  color?: string;
  /** Wrap width in pixels. When omitted, only explicit newlines break lines. */
  maxWidth?: number;
  /** Line advance in pixels. Default `20`. */
  lineHeight?: number;
  /** Whether to preserve leading spaces (default false). */
  preserveLeadingSpaces?: boolean;
  /** Allow browser-native drag selection and copy. Default `true`. */
  selectable?: boolean;
  /**
   * Horizontal alignment. `'justify'` stretches every wrapped line flush to
   * {@link maxWidth} (paragraph-final and newline-ended lines stay ragged);
   * `'center'` / `'right'` shift each wrapped line by
   * `(maxWidth − lineWidth) × ½ / 1`; `'left'` (default) leaves them ragged.
   * Needs {@link maxWidth} to take effect — without one, center/right behave
   * like left. When justify (or {@link hyphenate}) is active the component
   * draws glyph-by-glyph; left/center/right keep the fast one-`fillText`-per-
   * line path, with each aligned line's selection box tracking its glyphs via a
   * positioned single-run carrier.
   */
  textAlign?: 'left' | 'center' | 'right' | 'justify';
  /**
   * Optional hyphenator: given a word, return its break parts (e.g.
   * `['hyphen', 'ation']`). A word that doesn't fit breaks at the chosen point
   * with a visible `-`. Soft hyphens (U+00AD) in the text work without one.
   */
  hyphenate?: (word: string) => string[];
}

/**
 * A {@link GlyphMeasurer} that measures with the exact CSS `font` (so width
 * matches what the renderer draws, weights included).
 *
 * Without a DOM it falls back to metrics registered via `registerFontMetrics`,
 * and only when there are none does the {@link LayoutEngine} keep its portable
 * 0.5em fallback. Canvas is preferred whenever it exists: it is the only source
 * that measures the font actually being drawn.
 *
 * Goes through {@link getSharedMeasuringContext} rather than creating a canvas,
 * for both reasons that helper exists: its canvas is ATTACHED, so Firefox
 * resolves a generic family (`monospace`, `serif`) the same way the painted
 * canvas does instead of falling back to a different font, and it is shared, so
 * a component per text object does not leak a canvas element per text object.
 */
function fontMeasurer(font: string): GlyphMeasurer | null {
  if (typeof document === 'undefined') return createMetricsMeasurer(familyOf(font));
  const ctx = getSharedMeasuringContext();
  if (!ctx) return createMetricsMeasurer(familyOf(font));
  const cache = new Map<string, number>();
  return {
    measure(
      char: string,
      _fontSize?: number,
      _fontFamily?: string,
      _bold?: boolean,
      _italic?: boolean,
    ): number {
      let w = cache.get(char);
      if (w === undefined) {
        ctx.font = font;
        w = ctx.measureText(char).width;
        cache.set(char, w);
      }
      return w;
    },
  };
}

/** Extra lines drawn above and below a ScrollView-driven window, so fast
 *  scrolling never shows a blank edge before the next drive lands. */
const VISIBLE_RANGE_OVERSCAN_LINES = 2;

/**
 * A multi-line text component rendered with native canvas `fillText`.
 *
 * Wrapping and measurement go through the shared {@link LayoutEngine} (same
 * `Intl.Segmenter` path as `TextEntity`), with its cold/hot split: {@link setText}
 * re-measures (cold), {@link setMaxWidth} only re-wraps (hot). Projects a `div`
 * shadow node carrying the text as its accessible name.
 *
 * Implements ScrollView's duck-typed `ScrollVirtualizable` contract: when
 * driven by {@link Text.setVisibleRange}, only the lines inside the pushed
 * window are drawn (see {@link render}). Never driven — e.g. outside a
 * ScrollView — every line draws exactly as before.
 *
 * @example new Text('Hello world', { maxWidth: 200 }).setPosition(20, 20);
 */
export class Text extends UIComponent {
  public text: string;
  public font: string;
  public color: string;
  public maxWidth?: number;
  public lineHeight: number;
  public selectable: boolean;

  private engine: LayoutEngine;
  private prepared: PreparedText;
  private fontSize: number;
  /**
   * Component-level horizontal alignment. The {@link LayoutEngine} only knows
   * `'left' | 'justify'` (its own {@link LayoutEngine.textAlign}), so center /
   * right are a post-layout concern here: every wrapped line keeps its natural
   * left-aligned geometry and gets a per-line x-offset instead (see
   * {@link lineOffsets}). Justify is still forwarded to the engine, which owns
   * glyph placement for it.
   */
  private uiAlign: 'left' | 'center' | 'right' | 'justify';
  private lines: string[] = [];
  private lineSourceRanges: Array<{ start: number; end: number }> = [];
  /** Per-glyph nodes from the last layout, kept only when a glyph-accurate
   *  render path is active (justify or hyphenate) — left-aligned text draws one
   *  `fillText` per line and never touches this. */
  private glyphNodes: LayoutNode[] = [];
  private perGlyph = false;
  /**
   * Per-visual-line x-offset applied at paint and projection time, recomputed
   * by {@link applyLayout}. Zero everywhere for left/justify (justify is
   * engine-driven); for `'center'` / `'right'` line i is shifted by
   * `(maxWidth − measureText(line_i)) × {center: ½, right: 1}`. Line widths are
   * measured with the shared LRU-cached `measureText`, which measures the whole
   * shaped line string — the same extent the fast path's single `fillText`
   * paints. Bidi content keeps pure engine placement (see
   * {@link bidiLineOriginX}) and never takes an alignment offset, mirroring how
   * justify likewise stays off the bidi path.
   */
  private lineOffsets: number[] = [];
  /**
   * Bumped whenever a layout or a projected property changes.
   *
   * Read by `Scene` to skip re-projecting an unchanged block. Every mutator
   * routes through {@link applyLayout} except {@link setSelectable}, which bumps
   * it directly. Assigning the public `text`/`font`/`lineHeight` fields without
   * calling a setter does not bump it — but that already fails to repaint the
   * canvas, because `render()` draws from the laid-out `lines`/`glyphNodes`
   * rather than from `text`, so it is not a working pattern to begin with.
   */
  private contentEpoch = 0;
  /** True when the last layout produced any RTL glyph (bidi content). Engages
   *  the glyph-accurate render + positioned-carrier projection so selection
   *  overlaps the reordered / right-aligned canvas glyphs. */
  private hasBidi = false;
  /**
   * Inclusive `[startLine, endLine]` window last pushed by
   * {@link setVisibleRange}, or `null` while never driven (draw everything).
   * Cleared by every full relayout, since those renumber the visual lines.
   */
  private visibleLines: { start: number; end: number } | null = null;

  constructor(text: string, opts: TextOptions = {}) {
    super();
    this.text = text;
    this.font = opts.font ?? '16px sans-serif';
    this.color = opts.color ?? '#e2e8f0';
    this.maxWidth = opts.maxWidth;
    this.lineHeight = opts.lineHeight ?? 20;
    this.selectable = opts.selectable ?? true;
    this.fontSize = fontSizePx(this.font);
    this.engine = new LayoutEngine(this.maxWidth ?? 1e9, 1e9, fontMeasurer(this.font));
    if (opts.preserveLeadingSpaces) {
      this.engine.preserveLeadingSpaces = true;
    }
    this.uiAlign = opts.textAlign ?? 'left';
    this.engine.textAlign = this.uiAlign === 'justify' ? 'justify' : 'left';
    if (opts.hyphenate) this.engine.hyphenate = opts.hyphenate;
    // Justify moves glyphs within a line and hyphenate inserts a '-' not in the
    // source string, so a single fillText(line) can't reproduce either; switch
    // to the glyph-accurate render path when either is on. Left/center/right
    // text keeps the fast one-fillText-per-line default — alignment shifts the
    // whole line, which one fillText expresses exactly as well as left does.
    this.perGlyph = this.uiAlign === 'justify' || !!opts.hyphenate;
    this.prepared = this.engine.prepare(this.text, EMPTY_GLYPH_ATLAS, this.fontSize);
    // Re-run the cold pass when a webfont finishes loading: `prepared` and the
    // measurer's per-char cache were computed against pre-load pixels, so wrap
    // points and glyph advances would stay stale until an unrelated edit
    // re-prepared them (see watchFontMetrics). The fresh engine copies the
    // configured behaviour of the one it replaces.
    this.watchFontMetrics(() => {
      const old = this.engine;
      const fresh = new LayoutEngine(this.maxWidth ?? 1e9, 1e9, fontMeasurer(this.font));
      fresh.preserveLeadingSpaces = old.preserveLeadingSpaces;
      fresh.textAlign = old.textAlign;
      fresh.hyphenate = old.hyphenate;
      this.engine = fresh;
      this.prepared = this.engine.prepare(this.text, EMPTY_GLYPH_ATLAS, this.fontSize);
      this.applyLayout();
      this.scene?.markDirty();
    });
    // Not interactive: static text's semantic presence is its content
    // projection. An interactive a11y div would sit ABOVE the selectable
    // projection with pointer-events: auto and eat the mousedown — native
    // mouse selection on the text would never start (RichText does the same).
    this.interactive = false;
    this.applyLayout();
  }

  /**
   * Replace the text. Runs the **cold** pass (re-segment + re-measure), then re-lays out.
   *
   * @param text - The new text content.
   * @returns `this` for chaining.
   */
  /**
   * Positioned per-word runs for a justified line, so the DOM selection box
   * overlaps the widened canvas spacing instead of drifting. Each word run's `x`
   * is its first glyph's canvas x and its `width` is the word's own advance;
   * every inter-word space becomes its OWN run whose width spans the widened gap
   * to the next word, so the gap stays selectable and the space character really
   * exists for copy. Only used on the justify path — left-aligned text keeps the
   * cheaper single-string line.
   */
  private justifiedRuns(lineIndex: number): ContentProjectionRun[] | undefined {
    const lineQuantum = this.fontSize * 1.5;
    // SOURCE order, deliberately not sorted by `x`. The concatenated run text has
    // to reproduce the line exactly, and only source order guarantees that. A
    // line-trailing space is also the case that makes an `x` sort wrong rather
    // than merely unnecessary: justify collapses it, so the engine leaves it at
    // the last word's own x (measured: `' '` at x=64 on a line whose last word
    // occupies 64..80), and sorting by x splices it INTO that word — turning
    // `'aa'` into `'a'` + `'a'`. Only the non-bidi path reaches here (see
    // `getContentProjection`), so source order is already visual order for every
    // painted glyph.
    const glyphs = this.glyphNodes.filter((n) => Math.round(n.y / lineQuantum) === lineIndex);
    if (glyphs.length === 0) return undefined;
    const runs: ContentProjectionRun[] = [];
    // Right edge of the last emitted run, so a collapsed trailing space can be
    // placed at the line end instead of at its own artifact x.
    let cursor = glyphs[0].x;
    const push = (text: string, x: number, width: number) => {
      runs.push({ text, x, width, font: this.font });
      cursor = x + width;
    };
    let wordStart = -1;
    const flushWord = (endExclusive: number) => {
      if (wordStart < 0) return;
      const first = glyphs[wordStart];
      const last = glyphs[endExclusive - 1];
      const text = glyphs
        .slice(wordStart, endExclusive)
        .map((n) => n.char)
        .join('');
      // The word's OWN extent. The trailing gap belongs to the following space
      // run, which carries the space character that copy needs — folding the gap
      // into this width instead emitted no space at all (measured: zero spaces
      // in the projected text of a justified paragraph).
      push(text, first.x, last.x + last.width - first.x);
      wordStart = -1;
    };
    for (let i = 0; i < glyphs.length; i++) {
      if (glyphs[i].char.trim() !== '') {
        if (wordStart < 0) wordStart = i;
        continue;
      }
      flushWord(i);
      const spaceStart = i;
      while (i + 1 < glyphs.length && glyphs[i + 1].char.trim() === '') i++;
      const text = glyphs
        .slice(spaceStart, i + 1)
        .map((n) => n.char)
        .join('');
      const nextX = glyphs[i + 1]?.x;
      if (nextX === undefined) {
        // Line-trailing space: justify collapsed it, the canvas paints nothing,
        // and its own x is the artifact described above. Emit it at the line end
        // with zero width — the character still exists for copy (the carrier
        // keeps `white-space: pre`), while a zero-width box contributes no
        // selection rectangle that could drift off the drawn glyphs.
        push(text, cursor, 0);
      } else {
        // Span to the next glyph so the run covers the gap justify widened; that
        // contiguity is what keeps the highlight seamless across the gap.
        push(text, glyphs[spaceStart].x, Math.max(0, nextX - glyphs[spaceStart].x));
      }
    }
    flushWord(glyphs.length);
    return runs.length > 0 ? runs : undefined;
  }

  /**
   * Positioned single-run carrier for a center/right-aligned line — the
   * non-justified sibling of {@link justifiedRuns}. The canvas paints the whole
   * line with ONE `fillText` at the line's alignment offset, so one run whose
   * `x` is that offset and whose `width` is the line's measured extent is
   * exactly its geometry: Scene places the run as a flow-relative positioned
   * carrier (Scene.ts's runs branch) pinned to the canvas-measured width
   * instead of the browser's own re-measurement, so the DOM selection box
   * overlaps the shifted glyphs instead of hugging the left edge at x=0.
   * Empty lines paint nothing and project nothing.
   */
  private alignedLineRun(lineIndex: number): ContentProjectionRun[] | undefined {
    const text = this.lines[lineIndex];
    if (!text.trim()) return undefined;
    return [
      {
        text,
        // x is the trimmed-extent offset (the paint origin); width stays the
        // UNTRIMMED measured extent so the selectable box covers every
        // character copy returns, the hung trailing space included — it may
        // poke past the ink (or maxWidth on right-aligned lines), exactly like
        // CSS hangs a wrap-point space into the margin.
        x: this.lineOffsets[lineIndex] ?? 0,
        width: measureText(text, this.font),
        font: this.font,
      },
    ];
  }

  /**
   * Visual left origin (min glyph x) of a bidi line. The engine right-aligns
   * RTL lines, so their glyphs don't start at x=0; projecting the logical line
   * string at this origin (with the browser doing its own bidi via `dir=auto`)
   * lets the DOM selection rectangles overlap the drawn glyphs, while the browser
   * keeps correct logical caret hit-mapping — which per-glyph carriers broke.
   */
  private bidiLineOriginX(lineIndex: number): number {
    const lineQuantum = this.fontSize * 1.5;
    let minX = Infinity;
    for (const n of this.glyphNodes) {
      if (Math.round(n.y / lineQuantum) === lineIndex && n.x < minX) minX = n.x;
    }
    return minX === Infinity ? 0 : minX;
  }

  /** Mirror the rendered text into the DOM content layer (find-in-page, SR, SEO). */
  public override getContentProjection(hint?: ContentProjectionHint): ContentProjection | null {
    if (!this.text) return null;
    // Coarse tier: return text only, skip the per-line build.
    if (hint?.textOnly) {
      return {
        text: this.text,
        font: this.font,
        lineHeight: this.lineHeight,
        selectable: this.selectable,
      };
    }
    const justified = this.uiAlign === 'justify';
    const aligned = this.uiAlign === 'center' || this.uiAlign === 'right';
    // Only build the rows in the band. Unlike the grid path, Scene reads these
    // positionally and every entry carries its own `y`, so a compacted array is
    // correct — no index alignment to preserve.
    const indices: number[] = [];
    for (let index = 0; index < this.lines.length; index++) {
      if (contentLineInHint(hint, index * this.lineHeight, this.lineHeight)) indices.push(index);
    }
    // Never emit zero lines: `lines: []` with non-empty `text` makes Scene
    // project one text node for the whole string, which is both geometrically
    // wrong and slower than the work being skipped.
    const rowIndices = indices.length > 0 ? indices : this.lines.map((_, i) => i);
    const lines = rowIndices.map((index) => {
      const visualText = this.lines[index];
      const range = this.lineSourceRanges[index] ?? { start: 0, end: 0 };
      const nextStart = this.lineSourceRanges[index + 1]?.start ?? this.text.length;
      // Justify uses per-word positioned carriers (widened gaps); center/right
      // use one positioned run per line (the alignment offset). Bidi/RTL does
      // NOT use carriers: per-glyph carriers overlap selection rects but break
      // logical caret hit-mapping (the browser can't resolve a click inside a
      // 1-char box back to the logical offset). Instead keep a single
      // natural-flow line string — the browser does its own bidi (correct caret
      // mapping) — but anchor it at the line's VISUAL origin so the right-aligned
      // RTL glyphs and the DOM selection box line up.
      const runs = this.hasBidi
        ? undefined
        : justified
          ? this.justifiedRuns(index)
          : aligned
            ? this.alignedLineRun(index)
            : undefined;
      const lineX = this.hasBidi ? this.bidiLineOriginX(index) : (this.lineOffsets[index] ?? 0);
      return {
        // Canvas keeps its visual glyph order; the semantic layer keeps logical
        // source order so native copy and RTL text remain correct.
        text: this.text.slice(range.start, range.end) || visualText,
        separatorAfter: this.text.slice(range.end, Math.max(range.end, nextStart)),
        x: lineX,
        y: index * this.lineHeight,
        baseline: this.lineHeight * 0.8,
        font: this.font,
        lineHeight: this.lineHeight,
        runs,
        // Natural-order lines only. Gecko grid-fits DOM advances to integer
        // device pixels while canvas keeps fractional ones, so a single text
        // node drifts from the painted glyphs by 1-2px across a body-text line.
        // Per-grapheme carriers pin every cluster to its measured canvas x.
        //
        // Deliberately NOT gated on font family or size: measured on Firefox 153
        // the disagreement's SIGN flips with size for one family (monospace
        // 12px -0.37, 15px 0.00, 22px +0.42, 24px -0.47), so no family or
        // threshold gate is sound. Emitting always is correct everywhere and
        // costs only DOM nodes on lines that did not need it.
        //
        // Excluded when bidi: DOM order is logical while x is visual, so
        // per-glyph carriers break caret hit-mapping (PR #146 revert). Excluded
        // when justified or aligned because those lines already carry
        // positioned runs.
        perGraphemeCarriers: !this.hasBidi && !justified && !aligned,
        // render()'s fast default paints this line as ONE shaped
        // `fillText(line)`, so the ink includes browser kerning and ligatures
        // and the carriers must be measured as shaped prefix differences. The
        // glyph-accurate path (perGlyph: justify/hyphenate, or bidi) paints per
        // glyph at unkerned layout x instead, so it must NOT declare shaped
        // paint.
        shapedPaint: !this.perGlyph && !this.hasBidi,
      };
    });
    return {
      text: this.text,
      font: this.font,
      lineHeight: this.lineHeight,
      // The canvas has already decided the exact line breaks. Project visual
      // rows independently so browser whitespace/wrapping can never create a
      // different selection grid at a fractional zoom level.
      lines,
      selectable: this.selectable,
    };
  }

  /** Enable or disable browser-native drag selection without rebuilding the entity. */
  public setSelectable(selectable: boolean): this {
    this.selectable = selectable;
    // The one projected property that does not go through applyLayout(). It
    // drives `pointer-events`/`user-select` on the projected node, so a missed
    // bump would leave text unselectable after opting in.
    this.contentEpoch++;
    this.scene?.markDirty();
    return this;
  }

  public override getContentEpoch(): number {
    return this.contentEpoch;
  }

  public setText(text: string): this {
    this.text = text;
    this.prepared = this.engine.prepare(this.text, EMPTY_GLYPH_ATLAS, this.fontSize);
    this.applyLayout();
    this.scene?.markDirty();
    return this;
  }

  /**
   * Append text — the streaming / typewriter path. Goes through the same cold
   * pass as {@link setText}, but the engine's paragraph memo reuses every
   * untouched leading paragraph, so only the changed (last) paragraph is
   * re-segmented + re-measured.
   *
   * @returns `this` for chaining.
   */
  public append(text: string): this {
    return this.setText(this.text + text);
  }

  /**
   * Change the wrap width and reflow via the cheap **hot** path (reuses the cached
   * measured text — no re-segmentation or re-measurement).
   *
   * @returns `this` for chaining.
   */
  public setMaxWidth(maxWidth: number): this {
    this.maxWidth = maxWidth;
    this.engine.maxWidth = maxWidth;
    this.applyLayout();
    this.scene?.markDirty();
    return this;
  }

  /**
   * Set horizontal alignment and re-lay out. `'justify'` stretches wrapped
   * lines flush to {@link setMaxWidth}'s width (the last line stays ragged) and
   * engages the glyph-accurate render path; `'center'` / `'right'` shift every
   * line by `(maxWidth − lineWidth) × ½ / 1` on the fast path, with a
   * positioned single-run carrier per line so selection tracks the glyphs.
   * Needs {@link maxWidth} — without one, center/right behave like left.
   */
  public setTextAlign(align: 'left' | 'center' | 'right' | 'justify'): this {
    this.uiAlign = align;
    this.engine.textAlign = align === 'justify' ? 'justify' : 'left';
    if (align === 'justify') this.perGlyph = true;
    this.applyLayout();
    this.scene?.markDirty();
    return this;
  }

  /** Hot pass: place the cached prepared text and regroup glyphs into lines. */
  private applyLayout(): void {
    // Every projected property this recomputes — lines, source ranges, bidi,
    // glyph positions — is what `getContentProjection()` reports, so one bump
    // here covers setText/append/setMaxWidth/setTextAlign.
    this.contentEpoch++;
    const result = this.engine.layoutPrepared(this.prepared);
    // Bidi (RTL / mixed) needs the glyph-accurate path too: the engine reorders
    // glyphs to visual order and right-aligns RTL lines, so a single logical
    // line string handed to the browser would re-bidi differently and the
    // selection box would not overlap the drawn glyphs. Detect any RTL glyph and
    // engage the positioned-carrier projection, same as justify/hyphenate.
    this.hasBidi = result.nodes.some((n) => (n as LayoutNode).isRTL === true);
    const glyphAccurate = this.perGlyph || this.hasBidi;
    // Retain glyph nodes for the glyph-accurate render/projection path; plain
    // left-aligned LTR text draws per line and never reads these.
    this.glyphNodes = glyphAccurate ? result.nodes : [];
    const lineQuantum = this.fontSize * 1.5; // the engine's internal line advance
    const byLine = new Map<number, string>();
    const nodesByLine = new Map<number, LayoutNode[]>();
    let maxIdx = -1;
    for (const node of result.nodes) {
      const idx = Math.round(node.y / lineQuantum);
      byLine.set(idx, (byLine.get(idx) ?? '') + node.char);
      const nodes = nodesByLine.get(idx) ?? [];
      nodes.push(node);
      nodesByLine.set(idx, nodes);
      if (idx > maxIdx) maxIdx = idx;
    }
    this.lines = [];
    this.lineSourceRanges = [];
    let previousEnd = 0;
    for (let i = 0; i <= maxIdx; i++) {
      this.lines.push(byLine.get(i) ?? '');
      const nodes = nodesByLine.get(i) ?? [];
      let start =
        nodes.length > 0
          ? Math.min(...nodes.map((node) => node.sourceIndex ?? previousEnd))
          : previousEnd;
      const end =
        nodes.length > 0
          ? Math.max(
              ...nodes.map((node) => (node.sourceIndex ?? previousEnd) + (node.sourceLength ?? 0)),
            )
          : start;
      // Source skipped before the first painted glyph (for example a leading
      // hard break or trimmed space) still belongs to the first visual row.
      if (i === 0) start = 0;
      this.lineSourceRanges.push({ start, end: Math.max(start, end) });
      previousEnd = Math.max(previousEnd, end);
    }

    if (this.lines.length === 0 && this.text) {
      this.lines = [''];
      this.lineSourceRanges = [{ start: 0, end: 0 }];
    }

    // Alignment offsets are a post-layout, per-line quantity: the engine stays
    // left-aligned (its own textAlign only knows left/justify), so center/right
    // shift each wrapped line by the slack between maxWidth and the line's
    // measured extent. measureText is LRU-cached and measures the whole shaped
    // string — exactly what the fast path's single fillText paints. The slack
    // comes from the TRIMMED extent: the engine retains the wrap-point trailing
    // space in the line string, and CSS text-align hangs that space — it paints
    // nothing and must not eat into the slack, or centered ink sits left of
    // true center and right-aligned ink stops short of the edge. Without a
    // maxWidth there is no slack to distribute and center/right degenerate to
    // left (same rule as justify needing a wrap width). Bidi keeps pure engine
    // placement; mixing an alignment shift into bidiLineOriginX would
    // double-offset lines the engine already right-aligns.
    const aligned = (this.uiAlign === 'center' || this.uiAlign === 'right') && !this.hasBidi;
    if (aligned && this.maxWidth !== undefined) {
      const factor = this.uiAlign === 'right' ? 1 : 0.5;
      const maxW = this.maxWidth;
      this.lineOffsets = this.lines.map((line) => {
        const w = measureText(line.trimEnd(), this.font);
        return line.trim() ? (maxW - w) * factor : 0;
      });
    } else {
      this.lineOffsets = new Array(this.lines.length).fill(0);
    }

    // A relayout renumbers every visual line, so any window pushed by a
    // driving ScrollView is stale — drop it and draw whole until the next
    // frame's drive re-pushes one.
    this.visibleLines = null;

    this.width = result.totalWidth;
    this.height = Math.max(maxIdx + 1, 1) * this.lineHeight;
  }

  public getA11yAttributes(): A11yAttributes {
    return { label: this.text };
  }

  /**
   * Receive the visible viewport from an enclosing {@link ScrollView}, which
   * detects this component via the duck-typed `ScrollVirtualizable` contract
   * (`typeof child.setVisibleRange === 'function'`) and pushes it every frame.
   *
   * Stores the inclusive line range intersecting
   * `[scrollY, scrollY + viewportHeight]` — widened by a two-line overscan so
   * sub-line offsets and spring overshoot never pop a partially visible edge
   * line out of existence — and both render paths skip lines outside it. The
   * stored range is cleared by any full relayout ({@link setText},
   * {@link setMaxWidth}, {@link setTextAlign}), so a Text that is never driven
   * keeps drawing every line with zero behavior change.
   *
   * @param scrollY - Content-space top of the viewport relative to this Text's own top.
   * @param viewportHeight - Visible height in pixels.
   */
  public setVisibleRange(scrollY: number, viewportHeight: number): void {
    const start = Math.max(0, Math.floor(scrollY / this.lineHeight) - VISIBLE_RANGE_OVERSCAN_LINES);
    const end =
      Math.ceil((scrollY + viewportHeight) / this.lineHeight) + VISIBLE_RANGE_OVERSCAN_LINES;
    const lastLine = Math.max(0, this.lines.length - 1);
    this.visibleLines = { start: Math.min(start, lastLine), end: Math.min(end, lastLine) };
  }

  /** Whether `line` may draw under the current window (`null` = everything draws). */
  private lineInWindow(line: number): boolean {
    const w = this.visibleLines;
    return w === null || (line >= w.start && line <= w.end);
  }

  public render(r: IRenderer): void {
    // Glyph-accurate path (justify / hyphenate): each glyph carries its own x
    // (justify widens gaps; hyphenate inserts a '-'), so draw them individually.
    // node.y is in the engine's line-quantum units — remap to the component's
    // lineHeight so vertical rhythm matches the fast path.
    if (this.perGlyph || this.hasBidi) {
      const lineQuantum = this.fontSize * 1.5;
      for (const node of this.glyphNodes) {
        if (!node.char.trim()) continue;
        const line = Math.round(node.y / lineQuantum);
        if (!this.lineInWindow(line)) continue;
        // The offset is 0 on every engine-aligned path (left/justify/bidi);
        // only center/right with hyphenate shifts per-glyph x here.
        r.fillText(
          node.char,
          node.x + (this.lineOffsets[line] ?? 0),
          (line + 0.8) * this.lineHeight,
          this.font,
          this.color,
        );
      }
      return;
    }
    // Fast default: one fillText per visual line, at the line's alignment
    // offset (0 for left/justify — byte-identical to the pre-alignment draw).
    // When a ScrollView has pushed a window via setVisibleRange, lines outside
    // [start, end] skip their fillText call — on tall selectable text those
    // calls are the dominant per-frame cost while scrolled.
    for (let i = 0; i < this.lines.length; i++) {
      if (!this.lines[i]) continue;
      if (!this.lineInWindow(i)) continue;
      r.fillText(
        this.lines[i],
        this.lineOffsets[i] ?? 0,
        (i + 0.8) * this.lineHeight,
        this.font,
        this.color,
      );
    }
  }
}
