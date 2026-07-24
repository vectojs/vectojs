import {
  A11yAttributes,
  IRenderer,
  LayoutEngine,
  type GlyphMeasurer,
  type LayoutNode,
  type PreparedText,
} from '@vectojs/core';
import { UIComponent } from './UIComponent';
import { fontSizePx } from './measure';
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
   * `'left'` (default) leaves them ragged. Needs {@link maxWidth} to take
   * effect. When justify (or {@link hyphenate}) is active the component draws
   * glyph-by-glyph; left-aligned text keeps the fast one-`fillText`-per-line path.
   */
  textAlign?: 'left' | 'justify';
  /**
   * Optional hyphenator: given a word, return its break parts (e.g.
   * `['hyphen', 'ation']`). A word that doesn't fit breaks at the chosen point
   * with a visible `-`. Soft hyphens (U+00AD) in the text work without one.
   */
  hyphenate?: (word: string) => string[];
}

/**
 * A {@link GlyphMeasurer} that measures with the exact CSS `font` (so width
 * matches what the renderer draws, weights included). Returns `null` without a
 * DOM, so the {@link LayoutEngine} keeps its portable 0.5em fallback.
 */
function fontMeasurer(font: string): GlyphMeasurer | null {
  if (typeof document === 'undefined') return null;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return null;
  const cache = new Map<string, number>();
  return {
    measure(char: string): number {
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

/**
 * A multi-line text component rendered with native canvas `fillText`.
 *
 * Wrapping and measurement go through the shared {@link LayoutEngine} (same
 * `Intl.Segmenter` path as `TextEntity`), with its cold/hot split: {@link setText}
 * re-measures (cold), {@link setMaxWidth} only re-wraps (hot). Projects a `div`
 * shadow node carrying the text as its accessible name.
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
  private lines: string[] = [];
  private lineSourceRanges: Array<{ start: number; end: number }> = [];
  /** Per-glyph nodes from the last layout, kept only when a glyph-accurate
   *  render path is active (justify or hyphenate) — left-aligned text draws one
   *  `fillText` per line and never touches this. */
  private glyphNodes: LayoutNode[] = [];
  private perGlyph = false;
  /** True when the last layout produced any RTL glyph (bidi content). Engages
   *  the glyph-accurate render + positioned-carrier projection so selection
   *  overlaps the reordered / right-aligned canvas glyphs. */
  private hasBidi = false;

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
    this.engine.textAlign = opts.textAlign ?? 'left';
    if (opts.hyphenate) this.engine.hyphenate = opts.hyphenate;
    // Justify moves glyphs within a line and hyphenate inserts a '-' not in the
    // source string, so a single fillText(line) can't reproduce either; switch
    // to the glyph-accurate render path when either is on. Left-aligned text
    // keeps the fast one-fillText-per-line default.
    this.perGlyph = this.engine.textAlign === 'justify' || !!opts.hyphenate;
    this.prepared = this.engine.prepare(this.text, {}, this.fontSize);
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
   * overlaps the widened canvas spacing instead of drifting. Each run's `x` is
   * its first glyph's canvas x and its `width` spans to the next word (gap
   * included), so the inter-word space is selectable and the highlight covers
   * the widened gap exactly. Only used on the justify path — left-aligned text
   * keeps the cheaper single-string line.
   */
  private justifiedRuns(lineIndex: number): ContentProjectionRun[] | undefined {
    const lineQuantum = this.fontSize * 1.5;
    const glyphs = this.glyphNodes
      .filter((n) => Math.round(n.y / lineQuantum) === lineIndex)
      .sort((a, b) => a.x - b.x);
    if (glyphs.length === 0) return undefined;
    const runs: ContentProjectionRun[] = [];
    let wordStart = -1;
    const flush = (endExclusive: number, nextX: number | undefined) => {
      if (wordStart < 0) return;
      const first = glyphs[wordStart];
      const text = glyphs
        .slice(wordStart, endExclusive)
        .map((n) => n.char)
        .join('');
      // Width spans to the next word's x (gap included) or the word's own end.
      const last = glyphs[endExclusive - 1];
      const ownEnd = last.x + last.width;
      runs.push({
        text,
        x: first.x,
        width: (nextX ?? ownEnd) - first.x,
        font: this.font,
      });
      wordStart = -1;
    };
    for (let i = 0; i < glyphs.length; i++) {
      const isSpace = glyphs[i].char.trim() === '';
      if (isSpace) {
        // Close the current word; the space is folded into the word's trailing
        // width (above), not its own carrier, so copy keeps a single space.
        flush(i, glyphs[i + 1]?.x);
      } else if (wordStart < 0) {
        wordStart = i;
      }
    }
    flush(glyphs.length, undefined);
    return runs.length > 0 ? runs : undefined;
  }

  /**
   * Positioned per-glyph runs for a bidi (RTL / mixed) line. Emitted in LOGICAL
   * order (sorted by source index) so DOM copy and screen-reader order stay
   * correct, but each carrier is positioned at its VISUAL x. Because every
   * carrier's `width` equals its glyph advance, the browser's inline-flow cursor
   * tracks the running `logicalX` in Scene, so `left = x - logicalX` lands each
   * glyph at its absolute visual x regardless of the (non-visual) DOM order —
   * the same technique the code-grid path uses. A selected logical range then
   * highlights the correct (possibly visually-discontiguous) rectangles, which
   * is exactly correct RTL selection behavior.
   */
  private bidiRuns(lineIndex: number): ContentProjectionRun[] | undefined {
    const lineQuantum = this.fontSize * 1.5;
    const glyphs = this.glyphNodes
      .filter((n) => Math.round(n.y / lineQuantum) === lineIndex)
      .slice()
      // Logical order for correct copy/AT; visual x is carried per run.
      .sort((a, b) => (a.sourceIndex ?? 0) - (b.sourceIndex ?? 0));
    if (glyphs.length === 0) return undefined;
    return glyphs.map((n) => ({
      // Carry the LOGICAL SOURCE substring, not `n.char`: for shaped scripts
      // (Arabic) `n.char` is the contextual presentation form (U+FExx), so
      // copy / screen-reader / find-in-page would get shaped codepoints instead
      // of normal base letters. sourceIndex/sourceLength map the glyph back to
      // the original text. (Hebrew is unshaped so both happen to match — which
      // is why an all-Hebrew test wouldn't catch this.)
      text:
        n.sourceLength && n.sourceLength > 0
          ? this.text.slice(n.sourceIndex ?? 0, (n.sourceIndex ?? 0) + n.sourceLength)
          : n.char,
      x: n.x,
      width: n.width,
      font: this.font,
    }));
  }

  /** Mirror the rendered text into the DOM content layer (find-in-page, SR, SEO). */
  public override getContentProjection(): ContentProjection | null {
    if (!this.text) return null;
    const justified = this.engine.textAlign === 'justify';
    const lines = this.lines.map((visualText, index) => {
      const range = this.lineSourceRanges[index] ?? { start: 0, end: 0 };
      const nextStart = this.lineSourceRanges[index + 1]?.start ?? this.text.length;
      // Bidi takes precedence: RTL/mixed needs per-glyph positioned carriers
      // (glyphs are reordered + right-aligned on canvas). Otherwise justify uses
      // per-word carriers, and plain LTR uses a single natural-flow string.
      const runs = this.hasBidi
        ? this.bidiRuns(index)
        : justified
          ? this.justifiedRuns(index)
          : undefined;
      return {
        // Canvas keeps its visual glyph order; the semantic layer keeps logical
        // source order so native copy and RTL text remain correct.
        text: this.text.slice(range.start, range.end) || visualText,
        separatorAfter: this.text.slice(range.end, Math.max(range.end, nextStart)),
        x: 0,
        y: index * this.lineHeight,
        baseline: this.lineHeight * 0.8,
        font: this.font,
        lineHeight: this.lineHeight,
        runs,
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
    this.scene?.markDirty();
    return this;
  }

  public setText(text: string): this {
    this.text = text;
    this.prepared = this.engine.prepare(this.text, {}, this.fontSize);
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
   * Set horizontal alignment (`'justify'` stretches wrapped lines flush to
   * {@link setMaxWidth}'s width; the last line stays ragged) and re-lay out.
   * Switching to `'justify'` engages the glyph-accurate render path.
   */
  public setTextAlign(align: 'left' | 'justify'): this {
    this.engine.textAlign = align;
    if (align === 'justify') this.perGlyph = true;
    this.applyLayout();
    this.scene?.markDirty();
    return this;
  }

  /** Hot pass: place the cached prepared text and regroup glyphs into lines. */
  private applyLayout(): void {
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

    this.width = result.totalWidth;
    this.height = Math.max(maxIdx + 1, 1) * this.lineHeight;
  }

  public getA11yAttributes(): A11yAttributes {
    return { label: this.text };
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
        r.fillText(node.char, node.x, (line + 0.8) * this.lineHeight, this.font, this.color);
      }
      return;
    }
    // Fast default: one fillText per visual line.
    for (let i = 0; i < this.lines.length; i++) {
      if (this.lines[i])
        r.fillText(this.lines[i], 0, (i + 0.8) * this.lineHeight, this.font, this.color);
    }
  }
}
