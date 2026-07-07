import { Entity, type ContentProjection } from '../tree/Entity';
import { LayoutEngine, type GlyphMeasurer, type PreparedText } from '../layout/LayoutEngine';
import { createCanvasMeasurer } from '../layout/measure';
import { IRenderer } from '../renderer/IRenderer';

// Shared across all TextEntity instances so the per-glyph measurement cache is
// reused. Matches the `sans-serif` family used by the native fillText fallback
// in render(), so measured widths agree with what's actually drawn.
let sharedMeasurer: GlyphMeasurer | null | undefined;
function defaultMeasurer(): GlyphMeasurer | null {
  if (sharedMeasurer === undefined) sharedMeasurer = createCanvasMeasurer('sans-serif');
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
   */
  public override getContentProjection(): ContentProjection | null {
    if (!this.text) return null;
    // 'sans-serif' matches the shared measurer and the fillText fallback.
    return { text: this.text, font: `${this.fontSize}px sans-serif` };
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
    const result = this.layout.layoutPrepared(this.prepared);
    this.nodes = result.nodes;

    // Feed bounding box to A11y Layer
    this.width = result.totalWidth;
    this.height = result.totalHeight;
    // Bounding box offset: text is drawn downwards from baseline, so we adjust Y
    this.a11yOffsetY = 0;
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
