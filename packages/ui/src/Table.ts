import { A11yAttributes, IRenderer } from '@vecto-ui/core';
import { UIComponent } from './UIComponent';

/** Construction options for {@link Table}. */
export interface TableOptions {
  /** Array of column header strings. */
  headers: string[];
  /** 2D array representing table rows and columns. */
  rows: string[][];
  /** Custom widths per column in pixels. If omitted, widths are distributed evenly. */
  colWidths?: number[];
  /** Total physical width of the table. Default `600`. */
  width?: number;
  /** Row height in pixels. Default `36`. */
  rowHeight?: number;
  /** Table background color. Default `'rgba(15, 15, 25, 0.4)'`. */
  bg?: string;
  /** Header row background color. Default `'rgba(255, 255, 255, 0.08)'`. */
  headerBg?: string;
  /** Grid border color. Default `'rgba(255, 255, 255, 0.15)'`. */
  borderColor?: string;
  /** Header text color. Default `'#ffffff'`. */
  headerTextColor?: string;
  /** Cell body text color. Default `'#e2e8f0'`. */
  textColor?: string;
  /** Typography styling. Default `'14px sans-serif'`. */
  font?: string;
}

/**
 * A Canvas-native Data Grid Table component.
 *
 * Renders structured columns and rows with borders, custom widths and typography,
 * while exporting a dynamic `role="grid"` A11y Landmark structure for assistive tech.
 *
 * @example
 * const table = new Table({
 *   headers: ['Name', 'Value'],
 *   rows: [['Item A', '100'], ['Item B', '200']],
 *   width: 400
 * });
 */
export class Table extends UIComponent {
  public headers: string[];
  public rows: string[][];
  public colWidths: number[];
  public rowHeight: number;
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
    this.rowHeight = opts.rowHeight ?? 36;
    this.bg = opts.bg ?? 'rgba(15, 15, 25, 0.4)';
    this.headerBg = opts.headerBg ?? 'rgba(255, 255, 255, 0.08)';
    this.borderColor = opts.borderColor ?? 'rgba(255, 255, 255, 0.15)';
    this.headerTextColor = opts.headerTextColor ?? '#ffffff';
    this.textColor = opts.textColor ?? '#e2e8f0';
    this.font = opts.font ?? '14px sans-serif';

    const totalWidth = opts.width ?? 600;
    this.width = totalWidth;
    this.height = (this.rows.length + 1) * this.rowHeight;

    if (opts.colWidths && opts.colWidths.length === this.headers.length) {
      this.colWidths = opts.colWidths;
    } else {
      const avg = totalWidth / this.headers.length;
      this.colWidths = Array.from({ length: this.headers.length }, () => avg);
    }

    this.interactive = true;
  }

  public getA11yAttributes(): A11yAttributes {
    return {
      role: 'grid',
      label: `Data table with ${this.headers.length} columns and ${this.rows.length} rows.`,
    };
  }

  public render(r: IRenderer): void {
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, 8);
    r.fill(this.bg);

    const textOffset = this.rowHeight / 2 + 5;

    // 1. Draw Headers
    r.beginPath();
    r.roundRect(0, 0, this.width, this.rowHeight, [8, 8, 0, 0]);
    r.fill(this.headerBg);

    let xAcc = 0;
    for (let colIdx = 0; colIdx < this.headers.length; colIdx++) {
      const colW = this.colWidths[colIdx];
      r.fillText(
        this.headers[colIdx],
        xAcc + 12,
        textOffset,
        `bold ${this.font}`,
        this.headerTextColor,
      );

      if (colIdx > 0) {
        r.beginPath();
        r.moveTo(xAcc, 0);
        r.lineTo(xAcc, this.height);
        r.stroke(this.borderColor, 1);
      }
      xAcc += colW;
    }

    // 2. Draw Rows & Cells
    for (let rowIdx = 0; rowIdx < this.rows.length; rowIdx++) {
      const yPos = (rowIdx + 1) * this.rowHeight;
      const rowData = this.rows[rowIdx];

      r.beginPath();
      r.moveTo(0, yPos);
      r.lineTo(this.width, yPos);
      r.stroke(this.borderColor, 1);

      xAcc = 0;
      for (let colIdx = 0; colIdx < this.headers.length; colIdx++) {
        const colW = this.colWidths[colIdx];
        const val = rowData[colIdx] ?? '';
        r.fillText(val, xAcc + 12, yPos + textOffset, this.font, this.textColor);
        xAcc += colW;
      }
    }

    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, 8);
    r.stroke(this.borderColor, 1.5);
  }
}
