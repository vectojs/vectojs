import { Entity, type ContentProjection, type ContentProjectionLine } from '../tree/Entity';
import {
  LayoutEngine,
  type GlyphMeasurer,
  type PreparedText,
  resolveGlyphMeasurer,
} from '@vectojs/layout';
import { IRenderer } from '../renderer/IRenderer';

// Shared across all TextEntity instances so the per-glyph measurement cache is
// reused. Matches the `sans-serif` family used by the native fillText fallback
// in render(), so measured widths agree with what's actually drawn.
//
// Only a resolved measurer is memoized. Caching a `null` would pin the very
// first answer for the process, so a DOM-free app that registers font metrics
// after constructing its first TextEntity would be stuck on the 0.5em fallback
// forever. Re-resolving while null costs a `typeof document` check plus a Map
// lookup, and stops as soon as either source can answer.
let sharedMeasurer: GlyphMeasurer | null = null;
function defaultMeasurer(): GlyphMeasurer | null {
  sharedMeasurer ??= resolveGlyphMeasurer('sans-serif');
  return sharedMeasurer;
}

export class TextEntity extends Entity {
  public text: string;
  private atlas: any;
  private layout: LayoutEngine;
  private prepared: PreparedText;
  private nodes: any[] = [];
  public fontSize: number;

  public fillStyle: string | any = '#94a3b8';
  public strokeStyle: string | any = null;
  public hoveredFillStyle: string | any = '#ffffff';
  public lineWidth: number = 1;

  private isHovered: boolean = false;
  /** Bumped by {@link applyLayout}; read by `Scene` to skip an unchanged sync. */
  private contentEpoch = 0;
  /**
   * Visual lines with real canvas geometry, rebuilt by {@link applyLayout}
   * exactly when `this.nodes` changes.
   *
   * Without this the Scene placed the DOM copy at the entity origin and let the
   * browser flow it at CSS `normal` line-height, while the canvas lays lines out
   * at `1.5em` pitch with the baseline at `0.8em` — so every line after the
   * first drifted further from the painted glyphs (measured ~6 px on line 0 and
   * ~0.35 em per line for a 24 px font, Firefox). Per-line carriers pin the DOM
   * baseline to the canvas baseline by construction, same as `ui/Text`.
   */
  private projectionLines: ContentProjectionLine[] = [];

  constructor(text: string, atlas: any, maxWidth: number, fontSize: number = 24) {
    super();
    this.text = text;
    this.atlas = atlas;
    this.fontSize = fontSize;
    this.layout = new LayoutEngine(maxWidth, 10000, defaultMeasurer());
    this.prepared = this.layout.prepare(this.text, this.atlas, this.fontSize);
    this.applyLayout();

    // Enable Agent Accessibility Semantic Layer
    this.interactive = true;

    this.on('hover', () => (this.isHovered = true));
    this.on('pointerleave', () => (this.isHovered = false));
  }

  /**
   * Mirror the rendered text into the DOM content layer: find-in-page, screen
   * readers, crawlers, and translation see the same string the canvas draws.
   *
   * Each visual line is emitted with its own y/baseline/line-height so the DOM
   * line boxes sit exactly on the drawn glyphs instead of flowing at the
   * browser's `normal` metrics. Line text is the LOGICAL source slice (not the
   * per-glyph visual text), so shaped or reordered content still copies and
   * finds in source order — the same contract `ui/Text` ships.
   */
  public override getContentProjection(): ContentProjection | null {
    if (!this.text) return null;
    // 'sans-serif' matches the shared measurer and the fillText fallback.
    return {
      text: this.text,
      font: `${this.fontSize}px sans-serif`,
      lineHeight: this.fontSize * 1.5,
      lines: this.projectionLines,
    };
  }

  public override getContentEpoch(): number {
    return this.contentEpoch;
  }

  /**
   * Replace the text content. Runs the **cold** measurement pass (re-segment +
   * re-measure) since the glyphs changed, then re-lays out.
   *
   * @returns `this` for chaining.
   */
  public setText(text: string): this {
    this.text = text;
    this.prepared = this.layout.prepare(this.text, this.atlas, this.fontSize);
    this.applyLayout();
    return this;
  }

  /**
   * Change the wrap width and reflow. Cheap **hot** path only — reuses the
   * cached {@link PreparedText}, doing no re-segmentation or re-measurement.
   * Ideal for responsive resize.
   *
   * @returns `this` for chaining.
   */
  public setMaxWidth(maxWidth: number): this {
    this.layout.maxWidth = maxWidth;
    this.applyLayout();
    return this;
  }

  /**
   * Set horizontal alignment (`'justify'` stretches wrapped lines flush to
   * the wrap width; the last line stays ragged) and reflow.
   */
  public setTextAlign(align: 'left' | 'justify'): this {
    this.layout.textAlign = align;
    this.applyLayout();
    return this;
  }

  /**
   * Plug a hyphenator (word → parts). Break opportunities are baked in during
   * the cold pass, so this re-prepares the current text. Soft hyphens
   * (U+00AD) in the text work without one.
   */
  public setHyphenator(fn: ((word: string) => string[]) | null): this {
    this.layout.hyphenate = fn;
    this.prepared = this.layout.prepare(this.text, this.atlas, this.fontSize);
    this.applyLayout();
    return this;
  }

  /** Hot pass: place the cached {@link PreparedText} and refresh the a11y box. */
  private applyLayout() {
    // The projection reports `text` + `fontSize` + the line geometry below;
    // every mutator that can change any of them routes through here
    // (`fontSize` is constructor-only), so one bump covers them all.
    this.contentEpoch++;
    const result = this.layout.layoutPrepared(this.prepared);
    this.nodes = result.nodes;

    // Feed bounding box to A11y Layer
    this.width = result.totalWidth;
    this.height = result.totalHeight;
    // Bounding box offset: text is drawn downwards from baseline, so we adjust Y
    this.a11yOffsetY = 0;

    // Regroup glyphs into the same visual rows the canvas draws, with source
    // ranges so the projected text stays byte-identical to `this.text`.
    const lineQuantum = this.fontSize * 1.5; // the engine's internal line advance
    const nodesByLine = new Map<number, Array<(typeof this.nodes)[number]>>();
    let maxIdx = -1;
    for (const node of this.nodes) {
      const idx = Math.round(node.y / lineQuantum);
      const list = nodesByLine.get(idx) ?? [];
      list.push(node);
      nodesByLine.set(idx, list);
      if (idx > maxIdx) maxIdx = idx;
    }
    const justify = this.layout.textAlign === 'justify';
    // First pass: every row's source extent, so a row's separator can pair
    // with the IMMEDIATE next row's start — including a blank row's own start,
    // which is only known once its own (empty) extent has been computed.
    const starts: number[] = [];
    const ends: number[] = [];
    let previousEnd = 0;
    for (let i = 0; i <= maxIdx; i++) {
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
      // Source skipped before the first painted glyph (a leading hard break or
      // trimmed space) still belongs to the first visual row.
      if (i === 0) start = 0;
      starts.push(start);
      ends.push(end);
      previousEnd = Math.max(previousEnd, end);
    }
    const lines: ContentProjectionLine[] = [];
    for (let i = 0; i <= maxIdx; i++) {
      const nodes = nodesByLine.get(i) ?? [];
      const start = starts[i];
      const end = ends[i];
      const nextStart = i + 1 <= maxIdx ? starts[i + 1] : this.text.length;
      const hasRtl = nodes.some((node) => node.isRTL === true);
      lines.push({
        text: this.text.slice(start, Math.max(start, end)),
        separatorAfter: this.text.slice(end, Math.max(end, nextStart)),
        x: 0,
        y: i * lineQuantum,
        baseline: this.fontSize * 0.8,
        font: `${this.fontSize}px sans-serif`,
        lineHeight: lineQuantum,
        // Per-grapheme carriers pin each cluster to its canvas-measured x so
        // Gecko's grid-fit advance rounding cannot drift the find-in-page
        // highlight off the drawn glyphs. Bidi lines must keep one text node
        // (DOM order is logical; per-glyph carriers break caret mapping), and
        // justify moves glyphs off their natural x, so both fall back to flow.
        ...(hasRtl || justify ? {} : { perGraphemeCarriers: true as const }),
      });
    }
    this.projectionLines = lines;
  }

  public isPointInside(globalX: number, globalY: number): boolean {
    const local = this.worldToLocal(globalX, globalY);
    if (!local) return false;
    return local.x >= 0 && local.x <= this.width && local.y >= 0 && local.y <= this.height;
  }

  public render(renderer: IRenderer): void {
    const currentFill = this.isHovered ? this.hoveredFillStyle : this.fillStyle;

    for (const node of this.nodes) {
      const glyph = this.atlas[node.char];

      if (!glyph) {
        renderer.save();
        renderer.translate(node.x, node.y + this.fontSize * 0.8); // Adjust baseline for native fillText
        renderer.fillText(node.char, 0, 0, `${this.fontSize}px sans-serif`, currentFill);
        renderer.restore();
        continue;
      }

      renderer.save();
      renderer.translate(node.x, node.y);

      const scale = this.fontSize / glyph.baseSize;
      renderer.scale(scale, scale);

      for (const path of glyph.ast.paths) {
        renderer.beginPath();
        for (const cmd of path.commands) {
          if (cmd.type === 'M') renderer.moveTo(cmd.x, cmd.y);
          else if (cmd.type === 'L') renderer.lineTo(cmd.x, cmd.y);
          else if (cmd.type === 'C')
            renderer.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y);
          else if (cmd.type === 'Z') renderer.closePath();
        }

        if (currentFill) {
          renderer.fill(currentFill);
        }
        if (this.strokeStyle) {
          renderer.stroke(this.strokeStyle, this.lineWidth / scale);
        }
      }
      renderer.restore();
    }
  }
}
