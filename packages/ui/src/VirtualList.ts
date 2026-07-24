import { Entity, IRenderer, A11yAttributes } from '@vectojs/core';
import { UIComponent } from './UIComponent';

/**
 * Fenwick (binary-indexed) tree over per-row heights, so a long list's
 * per-frame scroll math is O(log n) instead of O(n). It answers the three
 * queries VirtualList runs every frame:
 *   - `total()`            — sum of all row heights (O(1))
 *   - `prefix(i)`          — y of row `i`'s top = sum of heights [0, i) (O(log n))
 *   - `indexAt(y)`         — first row whose bottom exceeds `y` (O(log n))
 * plus O(log n) point updates when a row's measured height replaces its
 * estimate. Every row starts at `estimate`; `set(i, h)` applies the delta.
 */
export class RowHeights {
  private n: number;
  /** 1-indexed Fenwick tree of size n. */
  private tree: Float64Array;
  /** Current height per row (0-indexed); estimate until measured. */
  private heights: Float64Array;
  private _total = 0;

  constructor(n: number, estimate: number) {
    this.n = n;
    this.tree = new Float64Array(n + 1);
    this.heights = new Float64Array(n);
    // Seed every row with the estimate. Build in O(n) via the standard
    // linear Fenwick construction (add to self, propagate to parent).
    for (let i = 0; i < n; i++) this.heights[i] = estimate;
    for (let i = 1; i <= n; i++) {
      this.tree[i]! += estimate;
      const parent = i + (i & -i);
      if (parent <= n) this.tree[parent]! += this.tree[i]!;
    }
    this._total = estimate * n;
  }

  get length(): number {
    return this.n;
  }

  /** Current height of row `i` (estimate until measured). */
  heightOf(i: number): number {
    return this.heights[i]!;
  }

  total(): number {
    return this._total;
  }

  /** Replace row `i`'s height (applies the delta through the tree). */
  set(i: number, h: number): void {
    const delta = h - this.heights[i]!;
    if (delta === 0) return;
    this.heights[i] = h;
    this._total += delta;
    for (let k = i + 1; k <= this.n; k += k & -k) this.tree[k]! += delta;
  }

  /** Sum of heights of rows [0, i) — i.e. the top y of row `i`. */
  prefix(i: number): number {
    let sum = 0;
    for (let k = i; k > 0; k -= k & -k) sum += this.tree[k]!;
    return sum;
  }

  /**
   * First row index whose cumulative bottom edge is strictly greater than `y`
   * (the row that visually contains offset `y`). Clamped to [0, n-1]. Uses
   * Fenwick binary lifting, O(log n).
   */
  indexAt(y: number): number {
    if (y <= 0 || this.n === 0) return 0;
    let pos = 0;
    let remaining = y;
    // Highest power of two <= n.
    let logN = 1;
    while (logN << 1 <= this.n) logN <<= 1;
    for (let step = logN; step > 0; step >>= 1) {
      const next = pos + step;
      if (next <= this.n && this.tree[next]! <= remaining) {
        pos = next;
        remaining -= this.tree[pos]!;
      }
    }
    // `pos` = count of rows fully above `y`; that index is the row containing y.
    return Math.min(pos, this.n - 1);
  }
}

export interface VirtualListOptions<T> {
  /** Full data array. */
  items: T[];
  /** Factory: create a canvas Entity for the given item at the given index. */
  renderItem: (item: T, index: number) => Entity;
  /**
   * Estimated row height in pixels used before a row is measured.
   * For fixed-height lists set this to the exact row height for best performance.
   */
  estimatedRowHeight: number;
  width: number;
  height: number;
  /** Extra rows to render above & below the visible window. Default `3`. */
  overscan?: number;
}

/**
 * High-performance virtual scrolling list.
 *
 * Only renders rows inside the visible viewport plus `overscan` rows above/below.
 * Supports both **fixed-height** rows (set `estimatedRowHeight` to the exact value)
 * and **variable-height** rows (the measured `entity.height` of each rendered row
 * is cached automatically per index).
 *
 * @example
 * const list = new VirtualList({
 *   items: myData,
 *   renderItem: (item, i) => new Text({ text: item.label, font: '14px monospace' }),
 *   estimatedRowHeight: 22,
 *   width: 300,
 *   height: 600,
 * });
 * scene.add(list.setPosition(20, 20));
 */
export class VirtualList<T = unknown> extends UIComponent {
  private _items: T[];
  private _renderItem: (item: T, index: number) => Entity;
  private _estH: number;
  private _overscan: number;

  /** Fenwick prefix-sum over row heights (O(log n) scroll math). */
  private _heights: RowHeights;
  /** Which indices have a *measured* (not estimated) height. */
  private _measured: Set<number> = new Set();
  /** Currently rendered row entities keyed by item index. */
  private _pool: Map<number, Entity> = new Map();

  private _scrollY = 0;
  private _targetY = 0;
  private _velY = 0;
  private _drag = false;
  private _lastPY = 0;

  constructor(opts: VirtualListOptions<T>) {
    super();
    this._items = opts.items;
    this._renderItem = opts.renderItem;
    this._estH = opts.estimatedRowHeight;
    this._overscan = opts.overscan ?? 3;
    this._heights = new RowHeights(opts.items.length, opts.estimatedRowHeight);
    this.width = opts.width;
    this.height = opts.height;
    this.interactive = true;
    this.clipChildren = true;
    this._bindEvents();
    this._reconcile();
  }

  /**
   * Replace the full item list.
   * Clears the height cache and resets scroll position to top.
   */
  public setItems(items: T[]): void {
    this._items = items;
    this._heights = new RowHeights(items.length, this._estH);
    this._measured.clear();
    this._targetY = 0;
    this._scrollY = 0;
    this._reconcile();
    this.scene?.markDirty();
  }

  /** Scroll to make the row at `index` visible. */
  public scrollToIndex(index: number): void {
    this._targetY = Math.min(this._rowTop(index), Math.max(0, this._totalH() - this.height));
    this.scene?.markDirty();
  }

  public scrollToTop(): void {
    this._targetY = 0;
    this.scene?.markDirty();
  }

  public scrollToBottom(): void {
    this._targetY = Math.max(0, this._totalH() - this.height);
    this.scene?.markDirty();
  }

  private _totalH(): number {
    return this._heights.total();
  }

  private _rowTop(index: number): number {
    return this._heights.prefix(index);
  }

  private _visibleRange(): [number, number] {
    const top = this._scrollY;
    const bot = this._scrollY + this.height;
    // start = first row whose bottom edge crosses `top` (the row containing the
    // top of the viewport). end = last row whose TOP is above `bot`. Both O(log
    // n) via the Fenwick tree instead of a full scan. indexAt(bot) returns the
    // row *containing* bot; when bot lands exactly on a row boundary that row
    // starts at the viewport bottom (zero visible area), so back off by one to
    // match the original "top < bot" visibility test.
    const start = this._heights.indexAt(top);
    let end = this._heights.indexAt(bot);
    if (end > 0 && this._heights.prefix(end) >= bot) end--;
    // For an empty list the `min(length-1, …)` clamp yields -1 so the caller's
    // `for (i = s; i <= e)` renders nothing (never calls renderItem(undefined)).
    return [
      Math.max(0, start - this._overscan),
      Math.min(this._items.length - 1, end + this._overscan),
    ];
  }

  private _reconcile(): void {
    const [s, e] = this._visibleRange();
    const needed = new Set<number>();
    for (let i = s; i <= e; i++) needed.add(i);

    // Recycle out-of-range entities
    for (const [idx, ent] of this._pool) {
      if (!needed.has(idx)) {
        super.remove(ent);
        this._pool.delete(idx);
      }
    }

    // Mount/update visible rows
    let ry = this._rowTop(s);
    for (let i = s; i <= e; i++) {
      const h = this._heights.heightOf(i);
      if (!this._pool.has(i)) {
        const ent = this._renderItem(this._items[i], i);
        ent.x = 0;
        ent.y = ry - this._scrollY;
        ent.width = ent.width || this.width;
        super.add(ent);
        this._pool.set(i, ent);
        if (!this._measured.has(i) && ent.height > 0) {
          this._measured.add(i);
          this._heights.set(i, ent.height);
        }
      } else {
        this._pool.get(i)!.y = ry - this._scrollY;
      }
      ry += h;
    }
  }

  private _clamp(): void {
    const max = Math.max(0, this._totalH() - this.height);
    this._targetY = Math.max(0, Math.min(this._targetY, max));
  }

  private _bindEvents(): void {
    this.on('wheel', (e: WheelEvent) => {
      if (e.ctrlKey) return;
      e.preventDefault();
      this._targetY += e.deltaY;
      this._clamp();
      this.scene?.markDirty();
    });
    this.on('pointerdown', (e: { localY?: number }) => {
      if (e.localY === undefined) return;
      this._drag = true;
      this._lastPY = e.localY;
    });
    this.on('pointermove', (e: { localY?: number }) => {
      if (!this._drag || e.localY === undefined) return;
      const y = e.localY;
      this._targetY -= y - this._lastPY;
      this._lastPY = y;
      this._clamp();
      this.scene?.markDirty();
    });
    const end = () => {
      this._drag = false;
    };
    this.on('pointerup', end);
    this.on('pointerleave', end);
  }

  public override update(dt: number, time: number): void {
    super.update(dt, time);
    const diff = this._targetY - this._scrollY;
    this._velY += diff * 0.12;
    this._velY *= 0.82;
    if (Math.abs(this._velY) > 0.05 || Math.abs(diff) > 0.05) {
      this._scrollY += this._velY;
      this._reconcile();
      this.scene?.markDirty();
    } else {
      this._scrollY = this._targetY;
      this._velY = 0;
    }
  }

  /**
   * The scroll integrator lives in update(), not a property driver, so without
   * this override it is invisible to the Scene's idle checks: markDirty() from
   * inside update() is wiped by the loop's own end-of-tick `dirty = false`, and
   * the animation then advances at the 2 FPS idle throttle (or stalls entirely
   * in onDemand mode). Same class of bug as the ScrollView 0.2.x fix.
   */
  public override hasPendingAnimations(): boolean {
    return (
      super.hasPendingAnimations() ||
      Math.abs(this._targetY - this._scrollY) > 0.05 ||
      Math.abs(this._velY) > 0.05
    );
  }

  public getA11yAttributes(): A11yAttributes {
    return {
      role: 'list',
      label: `Virtual list with ${this._items.length} items`,
    };
  }

  public render(_r: IRenderer): void {
    // clipChildren handles viewport masking; nothing to draw here.
  }
}
