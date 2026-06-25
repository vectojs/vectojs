export interface IRenderer {
  clear(): void;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
  rotate(angle: number): void;
  setGlobalAlpha(alpha: number): void;

  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void;
  closePath(): void;

  fill(colorOrGradient: string | any): void;
  stroke(colorOrGradient: string | any, lineWidth?: number): void;
  fillText(text: string, x: number, y: number, font: string, color: string | any): void;

  createLinearGradient(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    colorStops: { stop: number; color: string }[],
  ): any;
}
