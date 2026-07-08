import { IRenderer } from './IRenderer';

/**
 * Canvas 2D implementation of {@link IRenderer}.
 *
 * Wraps a `CanvasRenderingContext2D`, applies HiDPI (`devicePixelRatio`)
 * scaling on construction, and delegates every path/fill/stroke call to the
 * native 2D API.  Used internally by {@link Scene}; obtain a reference via
 * `scene.getRenderer()` when direct access is needed.
 *
 * @example
 * const renderer = new CanvasRenderer(document.querySelector('canvas')!);
 * renderer.clear();
 * renderer.beginPath();
 * renderer.fill('#38bdf8');
 */
const TWO_PI = Math.PI * 2;

/** Device pixel ratio, or `1` in non-DOM (SSR/Node) environments. */
function getDevicePixelRatio(): number {
  return typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
}

export class CanvasRenderer implements IRenderer {
  private ctx: CanvasRenderingContext2D;
  private width: number;
  private height: number;

  /**
   * Max circles per batched `fill()`. A single Canvas 2D `fill()` over a path is
   * superlinear in sub-path count, so an unbounded batch is *slower* than many
   * small fills at high entity counts. Capping bounds each fill's path
   * complexity while still amortizing per-draw overhead. Tuned via the benchmark.
   */
  static readonly MAX_BATCH = 64;

  // Order-preserving batch state for fillCircle(): a run of same-style circles
  // accumulates into one path and is committed by a single fill() on flush().
  private batchActive: boolean = false;
  private batchColor: string = '';
  private batchAlpha: number = 1;
  private batchCount: number = 0;

  /**
   * @param canvas - The target canvas. Its backing store is resized to the
   *   logical size × devicePixelRatio.
   * @param size - Explicit logical size. Without it the renderer assumes a
   *   fullscreen canvas and sizes to the window — pass this for embedded /
   *   custom-container canvases (the Scene does when `disableWindowResize` is
   *   set) so the canvas's own dimensions aren't clobbered by the window's.
   */
  constructor(canvas: HTMLCanvasElement, size?: { width: number; height: number }) {
    const dpr = getDevicePixelRatio();
    // Fall back to the canvas's own size in SSR/Node where there is no window.
    this.width =
      size?.width ?? (typeof window !== 'undefined' ? window.innerWidth : canvas.width || 0);
    this.height =
      size?.height ?? (typeof window !== 'undefined' ? window.innerHeight : canvas.height || 0);

    canvas.width = this.width * dpr;
    canvas.height = this.height * dpr;
    // Record the logical size as CSS size (same as resize() does): on HiDPI
    // the canvas would otherwise *display* at the backing-store size, and a
    // remounted Scene needs the logical size to survive somewhere readable —
    // canvas.width now holds the DPR-scaled value.
    if (canvas.style) {
      canvas.style.width = `${this.width}px`;
      canvas.style.height = `${this.height}px`;
    }

    // getContext may be absent/return null in a headless canvas; stay constructible.
    const ctx = canvas.getContext('2d');
    this.ctx = ctx as CanvasRenderingContext2D;
    if (ctx) ctx.scale(dpr, dpr);
  }

  /**
   * Expose the underlying `CanvasRenderingContext2D` for operations not
   * covered by the {@link IRenderer} interface.
   *
   * @returns The raw 2D rendering context.
   */
  public getContext() {
    return this.ctx;
  }

  /**
   * Resize the backing canvas buffer and re-apply DPR scaling.
   *
   * Called automatically by {@link Scene} on `window.resize` events.
   *
   * @param width - New logical width in CSS pixels.
   * @param height - New logical height in CSS pixels.
   */
  public resize(width: number, height: number): void {
    const dpr = getDevicePixelRatio();
    this.width = width;
    this.height = height;
    this.ctx.canvas.width = width * dpr;
    this.ctx.canvas.height = height * dpr;
    // Sync CSS size so the logical and physical sizes match on HiDPI screens
    this.ctx.canvas.style.width = `${width}px`;
    this.ctx.canvas.style.height = `${height}px`;
    this.ctx.scale(dpr, dpr);
  }

  /** @inheritdoc */
  clear(): void {
    this.flush();
    this.ctx.clearRect(0, 0, this.width, this.height);
  }
  /** @inheritdoc */
  save(): void {
    this.flush();
    this.ctx.save();
  }
  /** @inheritdoc */
  restore(): void {
    this.flush();
    this.ctx.restore();
  }
  /** @inheritdoc */
  translate(x: number, y: number): void {
    this.ctx.translate(x, y);
  }
  /** @inheritdoc */
  scale(x: number, y: number): void {
    this.ctx.scale(x, y);
  }
  /** @inheritdoc */
  rotate(angle: number): void {
    this.ctx.rotate(angle);
  }
  /** @inheritdoc */
  setGlobalAlpha(alpha: number): void {
    this.ctx.globalAlpha = alpha;
  }

  /** @inheritdoc */
  clip(x: number, y: number, width: number, height: number): void {
    this.flush();
    this.ctx.beginPath();
    this.ctx.rect(x, y, width, height);
    this.ctx.clip();
  }

  /** @inheritdoc */
  beginPath(): void {
    this.flush();
    this.ctx.beginPath();
  }
  /** @inheritdoc */
  moveTo(x: number, y: number): void {
    this.ctx.moveTo(x, y);
  }
  /** @inheritdoc */
  lineTo(x: number, y: number): void {
    this.ctx.lineTo(x, y);
  }
  /** @inheritdoc */
  bezierCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number,
  ): void {
    this.ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
  }
  /** @inheritdoc */
  closePath(): void {
    this.ctx.closePath();
  }

  /** @inheritdoc */
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ): void {
    this.ctx.arc(x, y, radius, startAngle, endAngle, counterclockwise);
  }

  /** @inheritdoc */
  roundRect(x: number, y: number, width: number, height: number, radii: number | number[]): void {
    this.ctx.roundRect(x, y, width, height, radii as any);
  }

  /** @inheritdoc */
  drawImage(source: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void {
    this.flush();
    this.ctx.drawImage(source, dx, dy, dw, dh);
  }

  /** @inheritdoc */
  fillCircle(cx: number, cy: number, radius: number, color: string, alpha: number = 1): void {
    if (this.batchActive && (color !== this.batchColor || alpha !== this.batchAlpha)) {
      this.flush();
    }
    if (!this.batchActive) {
      this.ctx.beginPath();
      this.batchActive = true;
      this.batchColor = color;
      this.batchAlpha = alpha;
    }
    // moveTo before arc starts a fresh sub-path so circles don't connect.
    this.ctx.moveTo(cx + radius, cy);
    this.ctx.arc(cx, cy, radius, 0, TWO_PI);
    this.batchCount++;
    if (this.batchCount >= CanvasRenderer.MAX_BATCH) this.flush();
  }

  /** @inheritdoc */
  flush(): void {
    if (!this.batchActive) return;
    this.ctx.globalAlpha = this.batchAlpha;
    this.ctx.fillStyle = this.batchColor;
    this.ctx.fill();
    this.ctx.globalAlpha = 1;
    this.batchActive = false;
    this.batchCount = 0;
  }

  /** @inheritdoc */
  fill(color: string | any): void {
    this.flush();
    this.ctx.fillStyle = color;
    this.ctx.fill();
  }

  /** @inheritdoc */
  stroke(color: string | any, lineWidth: number = 1): void {
    this.flush();
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = lineWidth;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.stroke();
  }

  /** @inheritdoc */
  fillText(text: string, x: number, y: number, font: string, color: string | any): void {
    this.flush();
    this.ctx.font = font;
    this.ctx.fillStyle = color;
    this.ctx.fillText(text, x, y);
  }

  /** @inheritdoc */
  createLinearGradient(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    colorStops: { stop: number; color: string }[],
  ): any {
    const grad = this.ctx.createLinearGradient(x0, y0, x1, y1);
    for (const cs of colorStops) {
      grad.addColorStop(cs.stop, cs.color);
    }
    return grad;
  }

  /**
   * Canvas2D drawing contexts are automatically released when their
   * `<canvas>` element is GC'd, so there's no explicit GPU handle to free.
   * This method clears our internal batch state and is idempotent.
   */
  public dispose(): void {
    this.batchCount = 0;
    this.batchColor = '';
    this.batchAlpha = 1;
    this.batchActive = false;
  }
}
