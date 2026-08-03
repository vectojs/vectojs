import { A11yAttributes, IRenderer, Entity, type LayoutControlledProperty } from '@vectojs/core';
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
/** Horizontal placement of a column's cells. `null` means the default, `'left'`. */
export type ColumnAlign = 'left' | 'center' | 'right' | null;

export interface TableOptions {
  headers: TableCell[];
  rows: TableCell[][];
  colWidths?: number[];
  /**
   * Per-column horizontal alignment, one entry per column; a short or malformed
   * array falls back to all-`'left'`.
   *
   * Applied by positioning each cell entity inside its column, not by a text
   * alignment property — the text components accept only `'left' | 'justify'`,
   * so there is nothing to set. A consequence: for a cell that wrapped to
   * several lines this aligns the block, not each line within it.
   */
  align?: ColumnAlign[];
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

/** A transparent, structural `role="row"` container so the projected grid is
 *  `grid > row > gridcell`, which assistive tech requires. Not focusable and
 *  not a pointer surface — its cell hotspots own interaction. */
class RowHotspot extends UIComponent {
  constructor() {
    super();
    this.interactive = true;
  }
  /**
   * A Table computes every cell's and header's box from its column widths and row
   * heights, so all four geometry properties are recomputed each layout.
   */
  public override getLayoutControlledProperties(): ReadonlyArray<LayoutControlledProperty> {
    return ['x', 'y', 'width', 'height'];
  }

  public getA11yAttributes(): A11yAttributes {
    return { role: 'row', pointerEvents: 'none' };
  }
  public render(): void {}
}

/**
 * A transparent, focusable hotspot over one table cell so the a11y/automation
 * layer projects a real `role="gridcell"` (body) / `columnheader` (header) with
 * an accessible name and a roving tabindex a keyboard user can drive
 * (WCAG 4.1.2 / 2.1.1). The {@link Table} paints the cell text on canvas; this
 * hotspot sits above it purely for semantics + focus.
 */
class GridCellHotspot extends UIComponent {
  public rowIndex = -1; // -1 = header row
  public colIndex = 0;
  private label = '';

  constructor(private table: Table) {
    super();
    this.interactive = true;
    this.on('keydown', (e: KeyboardEvent) =>
      this.table.handleGridKey(e, this.rowIndex, this.colIndex),
    );
  }

  public bind(rowIndex: number, colIndex: number, label: string): void {
    this.rowIndex = rowIndex;
    this.colIndex = colIndex;
    this.label = label;
  }

  public getA11yAttributes(): A11yAttributes {
    return {
      role: this.rowIndex < 0 ? 'columnheader' : 'gridcell',
      label: this.label,
      tabIndex: this.table.isGridTabStop(this.rowIndex, this.colIndex) ? 0 : -1,
      // The cell's own selectable text projection sits underneath and must own
      // the pointer hit for native drag-selection; this hotspot exists only for
      // semantics + keyboard focus (roving tabindex), so it opts out of pointer
      // hit-testing. `pointer-events:none` does not affect keyboard focus.
      pointerEvents: 'none',
    };
  }

  public render(): void {
    /* invisible — Table paints the cell */
  }
}

/**
 * A canvas-native data table whose cells are VMT entities.
 *
 * String cells are normalized to {@link Text} children so every logical cell
 * owns exactly one content projection. Geometry is resolved by {@link layout}
 * before rendering; {@link render} only paints the table chrome.
 */
/**
 * Horizontal padding reserved inside each cell, per side.
 *
 * `fitCell` wraps cell text at `colWidths[column] - 2 * CELL_PADDING_PX`, and the
 * three positioning sites inset by one of these. That symmetry is what makes
 * right-alignment computable, so the two must move together.
 */
const CELL_PADDING_PX = 12;

export class Table extends UIComponent {
  public headers: TableCell[];
  public rows: TableCell[][];
  public colWidths: number[];
  /** Per-column horizontal alignment, normalized to one entry per column. */
  public align: ColumnAlign[];
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

  // ── Grid a11y (role=row/gridcell/columnheader + roving-tabindex keyboard) ──
  /** Pinned header row + its columnheader hotspots (created once). */
  private headerRow: RowHotspot | null = null;
  private headerCellHotspots: GridCellHotspot[] = [];
  /** Pool of body row hotspots (one per visible body row), each with a cell
   *  hotspot per column; re-bound to the row currently in each slot. */
  private bodyRowPool: Array<{ row: RowHotspot; cells: GridCellHotspot[] }> = [];
  /** The cell that owns the roving tab stop / focus. `-1` row = the header. */
  private _activeRow = -1;
  private _activeCol = 0;
  /**
   * Every `Entity` cell handed to this table, header or body.
   *
   * A field rather than a constructor local because {@link appendRows} has to
   * share it: `normalizeCell` rejects an `Entity` used twice, and without a
   * persistent set an appended row could re-use a cell already mounted in the
   * constructor. `Entity.add` silently re-parents, so that would move the cell
   * out of its original slot instead of failing.
   */
  private readonly seenCells = new Set<Entity>();

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
    this.align = this.normalizeColumnAlign(opts.align);

    this.headerCells = this.headers.map((cell) => this.normalizeCell(cell, true, this.seenCells));
    this.bodyCells = this.rows.map((row) => this.normalizeRow(row));
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
      this._syncGridA11y();
      this.scene?.markDirty();
    } else if (this._scrollY !== this._targetY) {
      this._scrollY = this._targetY;
      this._velY = 0;
      this.reconcileVirtualRows();
      this._syncGridA11y();
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
        cell.setPosition(this.cellX(x, column, cell.width), rowTop + (rh - cell.height) / 2);
        x += this.colWidths[column];
      }
      this.mountedRows.add(rowIndex);
    }
    this.scene?.markDirty();
  }

  /** Accessible name for a cell: the original string source, else the cell
   *  entity's own aria label / text if it exposes one, else empty. */
  private cellLabel(rowIndex: number, column: number): string {
    const src = rowIndex < 0 ? this.headers[column] : this.rows[rowIndex]?.[column];
    if (typeof src === 'string') return src;
    const ent = src as unknown as {
      text?: string;
      getA11yAttributes?: () => A11yAttributes;
    };
    if (ent && typeof ent.text === 'string') return ent.text;
    return ent?.getA11yAttributes?.().label ?? '';
  }

  private columnCount(): number {
    return this.headers.length;
  }

  /** Whether a given (row, col) owns the grid's single roving tab stop. Clamped
   *  so an out-of-range active cell (after data change / scroll) still yields
   *  exactly one tab stop at the header's first column. */
  public isGridTabStop(rowIndex: number, colIndex: number): boolean {
    const cols = this.columnCount();
    let r = this._activeRow;
    let c = this._activeCol;
    if (c < 0 || c >= cols) c = 0;
    if (r < -1 || r >= this.bodyCells.length) r = -1;
    return rowIndex === r && colIndex === c;
  }

  /**
   * Grid keyboard model (WCAG grid pattern): Arrow keys move the focused cell
   * one step (clamped at the edges, header is row -1); Home/End jump to the
   * first/last column of the row; Ctrl+Home/Ctrl+End jump to the first
   * header cell / last body cell. The target cell is scrolled into view and
   * focused.
   */
  public handleGridKey(e: KeyboardEvent, rowIndex: number, colIndex: number): void {
    const keys = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const cols = this.columnCount();
    const lastRow = this.bodyCells.length - 1;
    let r = rowIndex;
    let c = colIndex;
    switch (e.key) {
      case 'ArrowDown':
        r = Math.min(lastRow, r + 1);
        break;
      case 'ArrowUp':
        r = Math.max(-1, r - 1);
        break;
      case 'ArrowRight':
        c = Math.min(cols - 1, c + 1);
        break;
      case 'ArrowLeft':
        c = Math.max(0, c - 1);
        break;
      case 'Home':
        if (e.ctrlKey) {
          r = -1;
        }
        c = 0;
        break;
      case 'End':
        if (e.ctrlKey) {
          r = lastRow;
        }
        c = cols - 1;
        break;
    }
    this._focusCell(r, c);
  }

  private _focusCell(rowIndex: number, colIndex: number): void {
    this._activeRow = rowIndex;
    this._activeCol = colIndex;
    if (this.virtualized && rowIndex >= 0) {
      this._scrollRowIntoView(rowIndex);
      this.reconcileVirtualRows();
    }
    this._syncGridA11y();
    // Locate the freshly-synced hotspot and focus it.
    const target =
      rowIndex < 0
        ? this.headerCellHotspots[colIndex]
        : this.bodyRowPool
            .flatMap((p) => p.cells)
            .find((h) => h.rowIndex === rowIndex && h.colIndex === colIndex);
    target?.focus();
    this.scene?.markDirty();
  }

  /** Snap a body row into the viewport (virtualized) before focusing it. */
  private _scrollRowIntoView(rowIndex: number): void {
    const rh = this.baseRowHeight;
    const top = rowIndex * rh;
    const bottom = top + rh;
    const viewport = Math.max(0, this.viewportHeight - this.headerHeight);
    if (top < this._scrollY) {
      this._scrollY = this._targetY = top;
    } else if (bottom > this._scrollY + viewport) {
      this._scrollY = this._targetY = bottom - viewport;
    }
    this.clampScroll();
    if (this._scrollY > this._targetY) this._scrollY = this._targetY;
  }

  /**
   * Project the ARIA grid structure: a pinned header `role="row"` with one
   * `columnheader` per column, and one body `role="row"` per visible body row
   * (pooled, virtualization-aware) with a `gridcell` per column. Hotspots are
   * transparent and sit over the canvas-drawn cells purely for semantics +
   * roving-tabindex keyboard focus.
   */
  private _syncGridA11y(): void {
    const cols = this.columnCount();
    // Header row (created once, pinned as a direct Table child).
    if (!this.headerRow) {
      this.headerRow = new RowHotspot();
      this.add(this.headerRow);
      this.headerCellHotspots = Array.from({ length: cols }, () => {
        const h = new GridCellHotspot(this);
        this.headerRow!.add(h);
        return h;
      });
    }
    this.headerRow.x = 0;
    this.headerRow.y = 0;
    this.headerRow.width = this.width;
    this.headerRow.height = this.headerHeight;
    let hx = 0;
    for (let c = 0; c < cols; c++) {
      const h = this.headerCellHotspots[c];
      h.bind(-1, c, this.cellLabel(-1, c));
      h.x = hx;
      h.y = 0;
      h.width = this.colWidths[c];
      h.height = this.headerHeight;
      hx += this.colWidths[c];
    }

    // Body rows: which indices are on screen, and where each sits. Body row
    // hotspots parent to the scrolled clip when virtualized, else to the Table.
    const rh = this.baseRowHeight;
    const rowParent: Entity = this.bodyClip ?? this;
    let first: number;
    let last: number;
    let rowTopFor: (i: number) => number;
    if (this.virtualized) {
      const bodyViewport = Math.max(0, this.viewportHeight - this.headerHeight);
      first = Math.max(0, Math.floor(this._scrollY / rh) - this.overscan);
      last = Math.min(
        this.bodyCells.length - 1,
        Math.ceil((this._scrollY + bodyViewport) / rh) + this.overscan,
      );
      rowTopFor = (i) => i * rh - this._scrollY; // clip-relative
    } else {
      first = 0;
      last = this.bodyCells.length - 1;
      rowTopFor = (i) => {
        let y = this.headerHeight;
        for (let k = 0; k < i; k++) y += this.rowHeights[k];
        return y;
      };
    }
    const need = this.bodyCells.length === 0 ? 0 : last - first + 1;

    // Grow / shrink the pool.
    while (this.bodyRowPool.length < need) {
      const row = new RowHotspot();
      const cells = Array.from({ length: cols }, () => new GridCellHotspot(this));
      for (const cell of cells) row.add(cell);
      rowParent.add(row);
      this.bodyRowPool.push({ row, cells });
    }
    while (this.bodyRowPool.length > need) {
      const entry = this.bodyRowPool.pop()!;
      this.scene?.detachA11y?.(entry.row);
      for (const cell of entry.cells) this.scene?.detachA11y?.(cell);
      entry.row.parent?.remove(entry.row);
    }
    // A pool row may need to move between `this` and `bodyClip` if the mode
    // changed; ensure correct parent.
    for (let slot = 0; slot < need; slot++) {
      const i = first + slot;
      const { row, cells } = this.bodyRowPool[slot];
      if (row.parent !== rowParent) {
        row.parent?.remove(row);
        rowParent.add(row);
      }
      const top = rowTopFor(i);
      const rowH = this.virtualized ? rh : this.rowHeights[i];
      row.x = 0;
      row.y = top;
      row.width = this.width;
      row.height = rowH;
      let cx = 0;
      for (let c = 0; c < cols; c++) {
        const cell = cells[c];
        cell.bind(i, c, this.cellLabel(i, c));
        cell.x = cx;
        cell.y = 0;
        cell.width = this.colWidths[c];
        cell.height = rowH;
        cx += this.colWidths[c];
      }
    }
  }

  /**
   * The x of one cell inside its column, honouring that column's alignment.
   *
   * Shared by the header, the plain body, and the virtualized body. All three
   * must use it: a virtualized table that aligned differently from a plain one
   * would be a difference visible only past the scroll threshold.
   */
  private cellX(columnLeft: number, column: number, cellWidth: number): number {
    const columnWidth = this.colWidths[column];
    switch (this.align[column]) {
      case 'right':
        return columnLeft + columnWidth - CELL_PADDING_PX - cellWidth;
      case 'center':
        return columnLeft + (columnWidth - cellWidth) / 2;
      default:
        return columnLeft + CELL_PADDING_PX;
    }
  }

  private normalizeColumnAlign(align: ColumnAlign[] | undefined): ColumnAlign[] {
    const columns = this.headers.length;
    if (!align || align.length !== columns) {
      return Array.from({ length: columns }, () => null);
    }
    return align.map((value) =>
      value === 'center' || value === 'right' || value === 'left' ? value : null,
    );
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

  /**
   * Normalize one source row to exactly {@link headers}.length cells.
   *
   * Short rows are padded with `''` and long ones truncated, which is what makes
   * a ragged `rows` argument safe and keeps `bodyCells` rectangular — every
   * layout and a11y path indexes it by column without bounds-checking.
   */
  private normalizeRow(row: TableCell[]): Entity[] {
    return Array.from({ length: this.headers.length }, (_, column) =>
      this.normalizeCell(row[column] ?? '', false, this.seenCells),
    );
  }

  /**
   * Append body rows, reusing the existing cells instead of rebuilding them.
   *
   * Reproduces exactly what the constructor does per row — normalize to the
   * header's column count, reject a duplicate `Entity` cell, apply `selectable`,
   * and mount to the right parent for the current mode — then re-resolves
   * geometry through {@link layout}.
   *
   * Both `rows` and the private cell grid are written. That pairing is the whole
   * point: `layout()` walks the cell grid while {@link getA11yAttributes} counts
   * `rows`, so updating only one leaves a table that either renders rows it does
   * not announce or announces rows it does not render.
   *
   * **Append-only by design.** Existing row indices keep their meaning, so the
   * roving tab stop cannot be invalidated (`isGridTabStop` only ever clamps an
   * active row that is now out of range, and growth cannot put one out of range)
   * and no `detachA11y` bookkeeping is needed. A general `setRows` would need
   * both, which is why it is deliberately absent.
   *
   * To change an existing cell, mutate the cell entity you passed in and call
   * `layout()` — it re-measures from `cell.height`, so a `RichText` whose spans
   * you replaced is picked up. That is the intended path for a streamed row
   * whose content is still arriving.
   */
  public appendRows(rows: TableCell[][]): this {
    if (rows.length === 0) return this;

    for (const row of rows) {
      const cells = this.normalizeRow(row);
      this.rows.push(row);
      this.bodyCells.push(cells);
      // Virtualized mode mounts lazily in reconcileVirtualRows(), exactly as the
      // constructor leaves its body cells unmounted; mounting here would put
      // them on the table instead of inside the scrolling clip.
      if (!this.virtualized) {
        for (const cell of cells) this.add(cell);
      }
    }

    // Recomputes rowHeights and height, repositions, and re-syncs the grid a11y
    // hotspot pool so the new rows get their `gridcell` projection.
    this.layout();
    return this;
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
    const maxWidth = Math.max(1, this.colWidths[column] - 2 * CELL_PADDING_PX);
    const candidate = cell as unknown as SizableCell;
    candidate.setMaxWidth?.(maxWidth);
  }

  private syncStringCell(entity: Entity, source: TableCell | undefined): void {
    if (typeof source === 'string' && entity instanceof Text && entity.text !== source) {
      entity.setText(source);
    }
  }

  /**
   * Change the table's total width, rescaling columns proportionally, and re-lay
   * out.
   *
   * Assigning {@link width} alone is not enough: {@link colWidths} is resolved
   * once in the constructor from the width given there, and every cell's wrap
   * width, position and alignment derives from *those* per-column figures rather
   * than from `width`. A table whose `width` was reassigned therefore paints its
   * chrome at the new size while its cells stay laid out for the old one.
   *
   * Columns keep their relative proportions, so an explicit `colWidths` ratio
   * survives a resize — including one that came from the caller rather than from
   * the equal-split default.
   *
   * @returns `this` for chaining.
   */
  public setWidth(width: number): this {
    const next = Math.max(1, width);
    if (next === this.width) return this;
    const total = this.colWidths.reduce((sum, columnWidth) => sum + columnWidth, 0);
    this.width = next;
    // Rescale from the previous distribution rather than re-splitting equally:
    // re-splitting would silently discard a caller-supplied ratio on the first
    // resize. A degenerate total (a zero-column table) falls back to the split.
    this.colWidths =
      total > 0
        ? this.colWidths.map((columnWidth) => (columnWidth / total) * next)
        : this.colWidths.map(() => next / Math.max(1, this.colWidths.length));
    return this.layout();
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
      cell.setPosition(this.cellX(x, column, cell.width), (this.headerHeight - cell.height) / 2);
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
      this._syncGridA11y();
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
        cell.setPosition(this.cellX(x, column, cell.width), y + (rowHeight - cell.height) / 2);
        x += this.colWidths[column];
      }
      y += rowHeight;
    }

    this.height = y;
    this._syncGridA11y();
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
