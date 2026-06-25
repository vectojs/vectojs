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
export class CanvasRenderer implements IRenderer {
  private ctx: CanvasRenderingContext2D;
  private width: number;
  private height: number;

  constructor(canvas: HTMLCanvasElement) {
    const dpr = window.devicePixelRatio || 1;
    this.width = window.innerWidth;
    this.height = window.innerHeight;

    canvas.width = this.width * dpr;
    canvas.height = this.height * dpr;

    this.ctx = canvas.getContext('2d')!;
    this.ctx.scale(dpr, dpr);
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
    const dpr = window.devicePixelRatio || 1;
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
    this.ctx.clearRect(0, 0, this.width, this.height);
  }
  /** @inheritdoc */
  save(): void {
    this.ctx.save();
  }
  /** @inheritdoc */
  restore(): void {
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
  beginPath(): void {
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
    this.ctx.drawImage(source, dx, dy, dw, dh);
  }

  /** @inheritdoc */
  fill(color: string | any): void {
    this.ctx.fillStyle = color;
    this.ctx.fill();
  }

  /** @inheritdoc */
  stroke(color: string | any, lineWidth: number = 1): void {
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = lineWidth;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.stroke();
  }

  /** @inheritdoc */
  fillText(text: string, x: number, y: number, font: string, color: string | any): void {
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
}
