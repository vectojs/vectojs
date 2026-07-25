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
  /**
   * Enable virtualization: fix the table's height to this many pixels, pin the
   * header, and scroll the body — mounting (and projecting a11y for) only the
   * body rows within the viewport plus a small overscan. Body rows are laid out
   * at the fixed `rowHeight` in this mode (so scroll↔row-index is O(1)). Omit
   * for the classic behavior: the table grows to fit all rows, every cell stays
   * mounted, and rows keep their measured variable heights.
   */
  viewportHeight?: number;
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

  // ── Virtualization (opt-in via `viewportHeight`) ────────────────────────────
  /** Fixed viewport height when virtualized; `0` = classic grow-to-fit mode. */
  private readonly viewportHeight: number;
  private get virtualized(): boolean {
    return this.viewportHeight > 0;
  }
  /** Clipped, scrolled sub-container that owns the body cells while virtualized
   *  (the header stays pinned as a direct Table child). Only created in that
   *  mode; a single Table-level clip couldn't pin the header AND scroll the body. */
  private bodyClip: Entity | null = null;
  private _scrollY = 0;
  private _targetY = 0;
  private _velY = 0;
  private _drag = false;
  private _lastPY = 0;
  /** Body rows currently mounted into `bodyClip`, keyed by row index. */
  private readonly mountedRows = new Set<number>();
  private readonly overscan = 2;

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
    this.viewportHeight = opts.viewportHeight ?? 0;
    this.colWidths = this.normalizeColumnWidths(opts.colWidths);

    const seen = new Set<Entity>();
    this.headerCells = this.headers.map((cell) => this.normalizeCell(cell, true, seen));
    this.bodyCells = this.rows.map((row) =>
      Array.from({ length: this.headers.length }, (_, column) =>
        this.normalizeCell(row[column] ?? '', false, seen),
      ),
    );
    for (const cell of this.headerCells) this.add(cell);

    if (this.virtualized) {
      // Body cells live in a clipped, scrolled sub-container; only the visible
      // window is mounted (reconcileVirtualRows), pruning off-viewport cell
      // projection + a11y. The header stays a pinned direct child above it.
      const clip = new (class TableBodyClip extends Entity {
        isPointInside(): boolean {
          return false;
        }
        render(): void {}
      })(`${this.id}-bodyclip`);
      clip.clipChildren = true;
      this.bodyClip = clip;
      this.add(clip);
      this.bindScroll();
    } else {
      // Classic grow-to-fit: every cell mounted directly on the table.
      for (const row of this.bodyCells) for (const cell of row) this.add(cell);
    }

    this.interactive = true;
    this.layout();
  }

  private bindScroll(): void {
    this.on('wheel', (e: WheelEvent) => {
      e.preventDefault();
      this._targetY += e.deltaY;
      this.clampScroll();
      this.scene?.markDirty();
    });
    // Touch / pointer drag-to-scroll (mirrors VirtualList & ScrollView): the
    // body follows the finger 1:1. Without this a virtualized Table could only
    // be scrolled with a wheel — unusable on a touchscreen.
    this.on('pointerdown', (e: { localY?: number }) => {
      if (e.localY === undefined) return;
      this._drag = true;
      this._lastPY = e.localY;
    });
    this.on('pointermove', (e: { localY?: number }) => {
      if (!this._drag || e.localY === undefined) return;
      const y = e.localY;
      // Dragging the content down (finger moves down) reveals earlier rows →
      // scroll offset decreases; matches the wheel sign convention above.
      this._targetY -= y - this._lastPY;
      this._lastPY = y;
      this.clampScroll();
      this.scene?.markDirty();
    });
    const endDrag = () => {
      this._drag = false;
    };
    this.on('pointerup', endDrag);
    this.on('pointerleave', endDrag);
  }

  private clampScroll(): void {
    const bodyTotal = this.bodyCells.length * this.baseRowHeight;
    const bodyViewport = this.viewportHeight - this.headerHeight;
    const max = Math.max(0, bodyTotal - bodyViewport);
    this._targetY = Math.max(0, Math.min(this._targetY, max));
  }

  /**
   * Scroll integrator (mirrors Tree / VirtualList) + per-frame row reconcile so
   * a wheel-driven scroll mounts/unmounts body rows as they cross the viewport.
   */
  public override update(dt: number, time: number): void {
    super.update(dt, time);
    if (!this.virtualized) return;
    const diff = this._targetY - this._scrollY;
    this._velY += diff * 0.12;
    this._velY *= 0.82;
    if (Math.abs(this._velY) > 0.05 || Math.abs(diff) > 0.05) {
      this._scrollY += this._velY;
      this.reconcileVirtualRows();
      this.scene?.markDirty();
    } else if (this._scrollY !== this._targetY) {
      this._scrollY = this._targetY;
      this._velY = 0;
      this.reconcileVirtualRows();
    }
  }

  /** Keep the hand-rolled scroll integrator visible to the Scene idle throttle. */
  public override hasPendingAnimations(): boolean {
    return (
      super.hasPendingAnimations() ||
      (this.virtualized &&
        (Math.abs(this._targetY - this._scrollY) > 0.05 || Math.abs(this._velY) > 0.05))
    );
  }

  /**
   * Mount exactly the body rows in the scrolled viewport (± overscan) into the
   * clipped body container and unmount the rest — so a 100k-row table only ever
   * has a viewport-worth of cell entities (and their a11y/content projections)
   * live. Fixed `baseRowHeight` makes the visible range O(1) to compute.
   */
  private reconcileVirtualRows(): void {
    const clip = this.bodyClip;
    if (!clip) return;
    const rh = this.baseRowHeight;
    const bodyViewport = Math.max(0, this.viewportHeight - this.headerHeight);
    const first = Math.max(0, Math.floor(this._scrollY / rh) - this.overscan);
    const last = Math.min(
      this.bodyCells.length - 1,
      Math.ceil((this._scrollY + bodyViewport) / rh) + this.overscan,
    );

    // Unmount rows that scrolled out of the window.
    for (const rowIndex of this.mountedRows) {
      if (rowIndex < first || rowIndex > last) {
        for (const cell of this.bodyCells[rowIndex]) {
          this.scene?.detachA11y?.(cell);
          clip.remove(cell);
        }
        this.mountedRows.delete(rowIndex);
      }
    }
    // Mount + position rows now in the window (positions are viewport-relative:
    // the clip sits at y=headerHeight, so a row's local y subtracts scrollY).
    for (let rowIndex = first; rowIndex <= last; rowIndex++) {
      const row = this.bodyCells[rowIndex];
      const rowTop = rowIndex * rh - this._scrollY;
      const mounting = !this.mountedRows.has(rowIndex);
      let x = 0;
      for (let column = 0; column < row.length; column++) {
        const cell = row[column];
        if (mounting) {
          // Lazily sync text + fit width the first time this row enters the
          // window, so layout() stays O(viewport) rather than O(rows).
          this.syncStringCell(cell, this.rows[rowIndex]?.[column]);
          this.fitCell(cell, column);
          clip.add(cell);
        }
        cell.setPosition(x + 12, rowTop + (rh - cell.height) / 2);
        x += this.colWidths[column];
      }
      this.mountedRows.add(rowIndex);
    }
    this.scene?.markDirty();
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

    let x = 0;
    for (let column = 0; column < this.headerCells.length; column++) {
      const cell = this.headerCells[column];
      cell.setPosition(x + 12, (this.headerHeight - cell.height) / 2);
      x += this.colWidths[column];
    }

    if (this.virtualized) {
      // Fixed body row height (uniform) so scroll↔row-index is O(1); the body
      // is a clipped viewport and cell positions/width-fits are applied per
      // VISIBLE row by reconcileVirtualRows(). Crucially we do NOT walk every
      // row here — that would make layout() O(rows) and defeat virtualization;
      // off-viewport cells are synced/fitted lazily when they mount.
      this.rowHeights = this.bodyCells.map(() => this.baseRowHeight);
      this.height = this.viewportHeight;
      // Body clip sits just below the pinned header, spanning the rest.
      const clip = this.bodyClip!;
      clip.setPosition(0, this.headerHeight);
      clip.width = this.width;
      clip.height = Math.max(0, this.viewportHeight - this.headerHeight);
      this.clampScroll();
      this._scrollY = this._targetY;
      this.reconcileVirtualRows();
      this.scene?.markDirty();
      return this;
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
      pointerEvents: 'none',
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

    if (this.virtualized) {
      // Draw only the row separators crossing the viewport (O(visible rows)),
      // at viewport-relative y, instead of walking every row down past the clip.
      const rh = this.baseRowHeight;
      const first = Math.max(0, Math.floor(this._scrollY / rh));
      const last = Math.min(
        this.bodyCells.length,
        Math.ceil((this._scrollY + (this.height - this.headerHeight)) / rh),
      );
      for (let i = first; i <= last; i++) {
        const y = this.headerHeight + i * rh - this._scrollY;
        if (y <= this.headerHeight || y >= this.height) continue;
        r.beginPath();
        r.moveTo(0, y);
        r.lineTo(this.width, y);
        r.stroke(this.borderColor, 1);
      }
    } else {
      let y = this.headerHeight;
      for (const rowHeight of this.rowHeights) {
        r.beginPath();
        r.moveTo(0, y);
        r.lineTo(this.width, y);
        r.stroke(this.borderColor, 1);
        y += rowHeight;
      }
    }

    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, 8);
    r.stroke(this.borderColor, 1.5);
  }
}
