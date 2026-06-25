import { IRenderer } from './IRenderer';

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

  public getContext() {
    return this.ctx;
  }

  public resize(width: number, height: number): void {
    const dpr = window.devicePixelRatio || 1;
    this.width = width;
    this.height = height;
    this.ctx.canvas.width = width * dpr;
    this.ctx.canvas.height = height * dpr;
    this.ctx.scale(dpr, dpr);
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.width, this.height);
  }
  save(): void {
    this.ctx.save();
  }
  restore(): void {
    this.ctx.restore();
  }
  translate(x: number, y: number): void {
    this.ctx.translate(x, y);
  }
  scale(x: number, y: number): void {
    this.ctx.scale(x, y);
  }
  rotate(angle: number): void {
    this.ctx.rotate(angle);
  }
  setGlobalAlpha(alpha: number): void {
    this.ctx.globalAlpha = alpha;
  }

  beginPath(): void {
    this.ctx.beginPath();
  }
  moveTo(x: number, y: number): void {
    this.ctx.moveTo(x, y);
  }
  lineTo(x: number, y: number): void {
    this.ctx.lineTo(x, y);
  }
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
  closePath(): void {
    this.ctx.closePath();
  }

  fill(color: string | any): void {
    this.ctx.fillStyle = color;
    this.ctx.fill();
  }

  stroke(color: string | any, lineWidth: number = 1): void {
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = lineWidth;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.stroke();
  }

  fillText(text: string, x: number, y: number, font: string, color: string | any): void {
    this.ctx.font = font;
    this.ctx.fillStyle = color;
    this.ctx.fillText(text, x, y);
  }

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
