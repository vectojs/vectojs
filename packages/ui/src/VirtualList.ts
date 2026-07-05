import { Entity, IRenderer, A11yAttributes } from '@vectojs/core';
import { UIComponent } from './UIComponent';

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

  /** Measured height cache: item index → actual px height. */
  private _hCache: Map<number, number> = new Map();
  /** Currently rendered row entities keyed by item index. */
  private _pool: Map<number, Entity> = new Map();

  private _scrollY = 0;
  private _targetY = 0;
  private _velY = 0;
  private _drag = false;
  private _lastPY = 0;

  constructor(opts: VirtualListOptions<T>) {
    super('VirtualList');
    this._items = opts.items;
    this._renderItem = opts.renderItem;
    this._estH = opts.estimatedRowHeight;
    this._overscan = opts.overscan ?? 3;
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
    this._hCache.clear();
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
    let h = 0;
    for (let i = 0; i < this._items.length; i++) h += this._hCache.get(i) ?? this._estH;
    return h;
  }

  private _rowTop(index: number): number {
    let y = 0;
    for (let i = 0; i < index; i++) y += this._hCache.get(i) ?? this._estH;
    return y;
  }

  private _visibleRange(): [number, number] {
    const top = this._scrollY;
    const bot = this._scrollY + this.height;
    let y = 0;
    let start = -1;
    let end = 0;
    for (let i = 0; i < this._items.length; i++) {
      const h = this._hCache.get(i) ?? this._estH;
      if (start === -1 && y + h > top) start = i;
      if (y < bot) end = i;
      y += h;
    }
    if (start === -1) start = 0;
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
      const h = this._hCache.get(i) ?? this._estH;
      if (!this._pool.has(i)) {
        const ent = this._renderItem(this._items[i], i);
        ent.x = 0;
        ent.y = ry - this._scrollY;
        ent.width = ent.width || this.width;
        super.add(ent);
        this._pool.set(i, ent);
        if (!this._hCache.has(i) && ent.height > 0) this._hCache.set(i, ent.height);
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
    }
  }

  public getA11yAttributes(): A11yAttributes {
    return { role: 'list', label: `Virtual list with ${this._items.length} items` };
  }

  public render(_r: IRenderer): void {
    // clipChildren handles viewport masking; nothing to draw here.
  }
}
