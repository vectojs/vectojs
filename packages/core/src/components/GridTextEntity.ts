import { Entity } from '../tree/Entity';
import { IRenderer } from '../renderer/IRenderer';

export class GridTextEntity extends Entity {
  public fontSize: number;
  public fillStyle: string = '#ffffff';

  public grid: string[] = []; // Array of rows
  public cols: number = 0;
  public rows: number = 0;

  public charWidth: number;
  public charHeight: number;

  constructor(_atlas: any, fontSize: number = 10) {
    super();
    this.fontSize = fontSize;
    this.charWidth = fontSize * 1.0;
    this.charHeight = fontSize * 1.1;
    this.interactive = false; // Disable A11y DOM for 10,000 characters to prevent browser crash
  }

  public updateGrid(ascii: string[]) {
    this.grid = ascii;
    this.rows = ascii.length;
    // Width is the WIDEST row, not the first one: a ragged grid whose first row
    // is empty (['', 'abc']) would otherwise lay out at 0 columns and paint
    // nothing, even though later rows have characters to draw.
    this.cols = ascii.reduce((widest, row) => Math.max(widest, row?.length ?? 0), 0);
  }

  public isPointInside(_globalX: number, _globalY: number): boolean {
    return false; // Interactive disabled for pure perf test
  }

  public render(renderer: IRenderer): void {
    if (this.rows === 0) return;

    for (let r = 0; r < this.rows; r++) {
      const row = this.grid[r];
      if (!row) continue;

      for (let c = 0; c < this.cols; c++) {
        const char = row[c];
        if (char === ' ') continue; // Zero-cost rendering for black pixels

        const x = c * this.charWidth;
        const y = r * this.charHeight;

        // Pure monospace font rendering to prevent overlap issues caused by differing character spacing between mathematical and native fonts.
        renderer.save();
        renderer.translate(x, y + this.fontSize * 0.8);
        renderer.fillText(char, 0, 0, `bold ${this.fontSize}px monospace`, this.fillStyle);
        renderer.restore();
      }
    }
  }
}
