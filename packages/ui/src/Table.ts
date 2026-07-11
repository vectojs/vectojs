import { A11yAttributes, IRenderer, Entity } from '@vectojs/core';
import { UIComponent } from './UIComponent';
import { Text } from './Text';

type TableCell = string | Entity;
interface SizableCell {
  setMaxWidth?(maxWidth: number): unknown;
}

interface SelectableCell {
  setSelectable?(selectable: boolean): unknown;
}

/** Construction options for {@link Table}. */
export interface TableOptions {
  headers: TableCell[];
  rows: TableCell[][];
  colWidths?: number[];
  width?: number;
  /** Minimum height for header and body rows. Default `36`. */
  rowHeight?: number;
  bg?: string;
  headerBg?: string;
  borderColor?: string;
  headerTextColor?: string;
  textColor?: string;
  font?: string;
  /** Allow browser-native drag selection and copy in cell text. Default `true`. */
  selectable?: boolean;
}

/**
 * A canvas-native data table whose cells are VMT entities.
 *
 * String cells are normalized to {@link Text} children so every logical cell
 * owns exactly one content projection. Geometry is resolved by {@link layout}
 * before rendering; {@link render} only paints the table chrome.
 */
export class Table extends UIComponent {
  public headers: TableCell[];
  public rows: TableCell[][];
  public colWidths: number[];
  public rowHeights: number[] = [];
  public headerHeight: number = 0;
  public bg: string;
  public headerBg: string;
  public borderColor: string;
  public headerTextColor: string;
  public textColor: string;
  public font: string;
  public selectable: boolean;

  private readonly baseRowHeight: number;
  private readonly headerCells: Entity[];
  private readonly bodyCells: Entity[][];

  constructor(opts: TableOptions) {
    super();
    if (opts.headers.length === 0) throw new RangeError('Table requires at least one column.');

    this.headers = opts.headers;
    this.rows = opts.rows;
    this.baseRowHeight = opts.rowHeight ?? 36;
    this.bg = opts.bg ?? 'rgba(15, 15, 25, 0.4)';
    this.headerBg = opts.headerBg ?? 'rgba(255, 255, 255, 0.08)';
    this.borderColor = opts.borderColor ?? 'rgba(255, 255, 255, 0.15)';
    this.headerTextColor = opts.headerTextColor ?? '#ffffff';
    this.textColor = opts.textColor ?? '#e2e8f0';
    this.font = opts.font ?? '14px sans-serif';
    this.selectable = opts.selectable ?? true;
    this.width = opts.width ?? 600;
    this.colWidths = this.normalizeColumnWidths(opts.colWidths);

    const seen = new Set<Entity>();
    this.headerCells = this.headers.map((cell) => this.normalizeCell(cell, true, seen));
    this.bodyCells = this.rows.map((row) =>
      Array.from({ length: this.headers.length }, (_, column) =>
        this.normalizeCell(row[column] ?? '', false, seen),
      ),
    );
    for (const cell of this.headerCells) this.add(cell);
    for (const row of this.bodyCells) for (const cell of row) this.add(cell);

    this.interactive = true;
    this.layout();
  }

  private normalizeColumnWidths(widths: number[] | undefined): number[] {
    const columns = this.headers.length;
    if (
      !widths ||
      widths.length !== columns ||
      widths.some((width) => !Number.isFinite(width) || width <= 0)
    ) {
      return Array.from({ length: columns }, () => this.width / columns);
    }
    const sum = widths.reduce((total, width) => total + width, 0);
    const scale = this.width / sum;
    return widths.map((width) => width * scale);
  }

  private normalizeCell(cell: TableCell, header: boolean, seen: Set<Entity>): Entity {
    if (typeof cell === 'string') {
      return new Text(cell, {
        font: header ? `bold ${this.font}` : this.font,
        color: header ? this.headerTextColor : this.textColor,
        lineHeight: 20,
        selectable: this.selectable,
      });
    }
    if (seen.has(cell)) {
      throw new Error('Table Entity cells must be unique instances.');
    }
    seen.add(cell);
    this.setCellSelectable(cell);
    return cell;
  }

  private setCellSelectable(cell: Entity): void {
    const candidate = cell as unknown as SelectableCell;
    candidate.setSelectable?.(this.selectable);
  }

  private fitCell(cell: Entity, column: number): void {
    const maxWidth = Math.max(1, this.colWidths[column] - 24);
    const candidate = cell as unknown as SizableCell;
    candidate.setMaxWidth?.(maxWidth);
  }

  private syncStringCell(entity: Entity, source: TableCell | undefined): void {
    if (typeof source === 'string' && entity instanceof Text && entity.text !== source) {
      entity.setText(source);
    }
  }

  /**
   * Recompute cell wrapping, row heights, and child positions.
   *
   * Call after mutating an externally supplied Entity cell. String-backed
   * cells are owned by the Table and are already kept consistent.
   */
  public layout(): this {
    this.headerHeight = this.baseRowHeight;
    for (let column = 0; column < this.headerCells.length; column++) {
      const cell = this.headerCells[column];
      this.syncStringCell(cell, this.headers[column]);
      this.fitCell(cell, column);
      this.headerHeight = Math.max(this.headerHeight, cell.height + 16);
    }

    this.rowHeights = this.bodyCells.map((row, rowIndex) => {
      let height = this.baseRowHeight;
      for (let column = 0; column < row.length; column++) {
        const cell = row[column];
        this.syncStringCell(cell, this.rows[rowIndex]?.[column]);
        this.fitCell(cell, column);
        height = Math.max(height, cell.height + 16);
      }
      return height;
    });

    let x = 0;
    for (let column = 0; column < this.headerCells.length; column++) {
      const cell = this.headerCells[column];
      cell.setPosition(x + 12, (this.headerHeight - cell.height) / 2);
      x += this.colWidths[column];
    }

    let y = this.headerHeight;
    for (let rowIndex = 0; rowIndex < this.bodyCells.length; rowIndex++) {
      const row = this.bodyCells[rowIndex];
      const rowHeight = this.rowHeights[rowIndex];
      x = 0;
      for (let column = 0; column < row.length; column++) {
        const cell = row[column];
        cell.setPosition(x + 12, y + (rowHeight - cell.height) / 2);
        x += this.colWidths[column];
      }
      y += rowHeight;
    }

    this.height = y;
    this.scene?.markDirty();
    return this;
  }

  /** Enable or disable browser-native selection for every selectable cell. */
  public setSelectable(selectable: boolean): this {
    this.selectable = selectable;
    for (const cell of this.headerCells) this.setCellSelectable(cell);
    for (const row of this.bodyCells) for (const cell of row) this.setCellSelectable(cell);
    this.scene?.markDirty();
    return this;
  }

  public getA11yAttributes(): A11yAttributes {
    return {
      role: 'grid',
      label: `Data table with ${this.headers.length} columns and ${this.rows.length} rows.`,
    };
  }

  /** Cell children own projected text, so the Table itself never duplicates it. */
  public override getContentProjection(): null {
    return null;
  }

  public render(r: IRenderer): void {
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, 8);
    r.fill(this.bg);

    r.beginPath();
    r.roundRect(0, 0, this.width, this.headerHeight, [8, 8, 0, 0]);
    r.fill(this.headerBg);

    let x = 0;
    for (let column = 0; column < this.headers.length; column++) {
      if (column > 0) {
        r.beginPath();
        r.moveTo(x, 0);
        r.lineTo(x, this.height);
        r.stroke(this.borderColor, 1);
      }
      x += this.colWidths[column];
    }

    let y = this.headerHeight;
    for (const rowHeight of this.rowHeights) {
      r.beginPath();
      r.moveTo(0, y);
      r.lineTo(this.width, y);
      r.stroke(this.borderColor, 1);
      y += rowHeight;
    }

    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, 8);
    r.stroke(this.borderColor, 1.5);
  }
}
