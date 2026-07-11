import { A11yAttributes, IRenderer, Entity } from '@vectojs/core';
import { UIComponent } from './UIComponent';

/** Construction options for {@link Table}. */
export interface TableOptions {
  headers: (string | Entity)[];
  rows: (string | Entity)[][];
  colWidths?: number[];
  width?: number;
  rowHeight?: number; // Base minimum row height
  bg?: string;
  headerBg?: string;
  borderColor?: string;
  headerTextColor?: string;
  textColor?: string;
  font?: string;
}

export class Table extends UIComponent {
  public headers: (string | Entity)[];
  public rows: (string | Entity)[][];
  public colWidths: number[];
  public rowHeights: number[];
  public headerHeight: number;
  public bg: string;
  public headerBg: string;
  public borderColor: string;
  public headerTextColor: string;
  public textColor: string;
  public font: string;

  constructor(opts: TableOptions) {
    super();
    this.headers = opts.headers;
    this.rows = opts.rows;
    const baseRowHeight = opts.rowHeight ?? 36;
    this.bg = opts.bg ?? 'rgba(15, 15, 25, 0.4)';
    this.headerBg = opts.headerBg ?? 'rgba(255, 255, 255, 0.08)';
    this.borderColor = opts.borderColor ?? 'rgba(255, 255, 255, 0.15)';
    this.headerTextColor = opts.headerTextColor ?? '#ffffff';
    this.textColor = opts.textColor ?? '#e2e8f0';
    this.font = opts.font ?? '14px sans-serif';

    const totalWidth = opts.width ?? 600;
    this.width = totalWidth;

    if (opts.colWidths && opts.colWidths.length === this.headers.length) {
      this.colWidths = opts.colWidths;
    } else {
      const avg = totalWidth / this.headers.length;
      this.colWidths = Array.from({ length: this.headers.length }, () => avg);
    }

    // Wrap an entity cell to its column. Assigning the `maxWidth` FIELD never
    // reaches the layout engine — only `setMaxWidth()` re-wraps (Text and
    // RichText both re-lay out inside it); the bare field write left cells
    // unwrapped and row heights measured on the unwrapped content.
    const fitCell = (cell: Entity, colIdx: number): void => {
      const sizable = cell as Entity & { setMaxWidth?: (w: number) => unknown };
      if (typeof sizable.setMaxWidth === 'function') {
        sizable.setMaxWidth(this.colWidths[colIdx] - 24);
      }
    };

    // Add child entities and compute dynamic heights
    this.headerHeight = baseRowHeight;
    this.headers.forEach((h, colIdx) => {
      if (typeof h !== 'string') {
        this.add(h);
        fitCell(h, colIdx);
        this.headerHeight = Math.max(this.headerHeight, h.height + 16);
      }
    });

    this.rowHeights = this.rows.map((row) => {
      let h = baseRowHeight;
      row.forEach((cell, colIdx) => {
        if (typeof cell !== 'string') {
          this.add(cell);
          fitCell(cell, colIdx);
          h = Math.max(h, cell.height + 16);
        }
      });
      return h;
    });

    this.height = this.headerHeight + this.rowHeights.reduce((a, b) => a + b, 0);
    this.interactive = true;
  }

  public getA11yAttributes(): A11yAttributes {
    return {
      role: 'grid',
      label: `Data table with ${this.headers.length} columns and ${this.rows.length} rows.`,
    };
  }

  public override getContentProjection() {
    const getText = (cell: string | Entity) =>
      typeof cell === 'string' ? cell : 'text' in cell ? (cell as any).text : '';
    const text = [
      this.headers.map(getText).join('\t'),
      ...this.rows.map((r) => r.map(getText).join('\t')),
    ].join('\n');
    return { text, font: this.font, selectable: true };
  }

  public render(r: IRenderer): void {
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, 8);
    r.fill(this.bg);

    // 1. Draw Headers
    r.beginPath();
    r.roundRect(0, 0, this.width, this.headerHeight, [8, 8, 0, 0]);
    r.fill(this.headerBg);

    let xAcc = 0;
    for (let colIdx = 0; colIdx < this.headers.length; colIdx++) {
      const colW = this.colWidths[colIdx];
      const h = this.headers[colIdx];

      if (typeof h === 'string') {
        r.save();
        r.clip(xAcc, 0, colW, this.headerHeight);
        r.fillText(
          h,
          xAcc + 12,
          this.headerHeight / 2 + 5,
          `bold ${this.font}`,
          this.headerTextColor,
        );
        r.restore();
      } else {
        h.x = xAcc + 12;
        h.y = (this.headerHeight - h.height) / 2;
      }

      if (colIdx > 0) {
        r.beginPath();
        r.moveTo(xAcc, 0);
        r.lineTo(xAcc, this.height);
        r.stroke(this.borderColor, 1);
      }
      xAcc += colW;
    }

    // 2. Draw Rows & Cells
    let yPos = this.headerHeight;
    for (let rowIdx = 0; rowIdx < this.rows.length; rowIdx++) {
      const rowData = this.rows[rowIdx];
      const rowH = this.rowHeights[rowIdx];

      r.beginPath();
      r.moveTo(0, yPos);
      r.lineTo(this.width, yPos);
      r.stroke(this.borderColor, 1);

      xAcc = 0;
      for (let colIdx = 0; colIdx < this.headers.length; colIdx++) {
        const colW = this.colWidths[colIdx];
        const val = rowData[colIdx];

        if (typeof val === 'string' || val == null) {
          const str = val ?? '';
          r.save();
          r.clip(xAcc, yPos, colW, rowH);
          r.fillText(str, xAcc + 12, yPos + rowH / 2 + 5, this.font, this.textColor);
          r.restore();
        } else {
          val.x = xAcc + 12;
          val.y = yPos + (rowH - val.height) / 2;
        }

        xAcc += colW;
      }
      yPos += rowH;
    }

    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, 8);
    r.stroke(this.borderColor, 1.5);
  }
}
