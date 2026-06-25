import { Entity } from '../tree/Entity';
import { IRenderer } from '../renderer/IRenderer';

export class GridTextEntity extends Entity {
  private atlas: any;
  public fontSize: number;
  public fillStyle: string = '#ffffff';

  public grid: string[] = []; // Array of rows
  public cols: number = 0;
  public rows: number = 0;

  public charWidth: number;
  public charHeight: number;

  constructor(atlas: any, fontSize: number = 10) {
    super();
    this.atlas = atlas;
    this.fontSize = fontSize;
    this.charWidth = fontSize * 1.0;
    this.charHeight = fontSize * 1.1;
    this.interactive = false; // Disable A11y DOM for 10,000 characters to prevent browser crash
  }

  public updateGrid(ascii: string[]) {
    this.grid = ascii;
    this.rows = ascii.length;
    this.cols = ascii[0]?.length || 0;
  }

  public isPointInside(globalX: number, globalY: number): boolean {
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

        const glyph = this.atlas[char];
        const x = c * this.charWidth;
        const y = r * this.charHeight;

        if (!glyph) {
          // Fast fallback
          renderer.save();
          renderer.translate(x, y + this.fontSize * 0.8);
          renderer.fillText(char, 0, 0, `bold ${this.fontSize}px monospace`, this.fillStyle);
          renderer.restore();
          continue;
        }

        renderer.save();
        renderer.translate(x, y);
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
          if (this.fillStyle) renderer.fill(this.fillStyle);
        }
        renderer.restore();
      }
    }
  }
}
