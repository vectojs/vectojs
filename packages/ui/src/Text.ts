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
import type { ContentProjection } from '@vectojs/core';

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
  /** Mirror the rendered text into the DOM content layer (find-in-page, SR, SEO). */
  public override getContentProjection(): ContentProjection | null {
    if (!this.text) return null;
    const lines = this.lines.map((visualText, index) => {
      const range = this.lineSourceRanges[index] ?? { start: 0, end: 0 };
      const nextStart = this.lineSourceRanges[index + 1]?.start ?? this.text.length;
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

  /** Hot pass: place the cached prepared text and regroup glyphs into lines. */
  private applyLayout(): void {
    const result = this.engine.layoutPrepared(this.prepared);
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
    for (let i = 0; i < this.lines.length; i++) {
      if (this.lines[i])
        r.fillText(this.lines[i], 0, (i + 0.8) * this.lineHeight, this.font, this.color);
    }
  }
}
