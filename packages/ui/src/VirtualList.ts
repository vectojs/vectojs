import { Entity, IRenderer, A11yAttributes, type DevtoolsDescriptor } from '@vectojs/core';
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
  /**
   * Stable identity for an item, enabling three things that index identity cannot
   * express: measured heights that survive {@link VirtualList.setItems}, a scroll
   * anchor that stays attached to a row while rows above it resize, and
   * append/prepend without discarding the cache.
   *
   * Without it the list behaves exactly as before — `setItems` clears every
   * measurement and jumps to the top, which is correct for a replaced list and
   * wrong for a growing one.
   *
   * Keys must be unique within the list; a duplicate makes two rows share one
   * cached height. For a chat transcript the message id is the natural key.
   */
  keyForItem?: (item: T, index: number) => string;
  /**
   * Distance from the bottom, in pixels, within which the list counts as
   * "following" and re-pins itself to the bottom after rows resize. Default `48`.
   *
   * Only consulted when {@link keyForItem} is set, since re-pinning is part of the
   * anchoring behaviour.
   */
  stickToBottomThreshold?: number;
}

/**
 * Where the viewport was before a size change, so it can be put back afterwards.
 *
 * Two variants because "keep the view still" means different things depending on
 * where the user is. At the bottom of a growing transcript it means *follow* the
 * new content; anywhere else it means keep the row under the viewport's top edge
 * exactly where it was, even though every row above it may have changed height.
 *
 * The item variant is keyed rather than indexed: an index is not stable across a
 * prepend, and the whole point is to survive geometry changes.
 */
type ScrollAnchor =
  | { kind: 'bottom'; distanceFromBottom: number }
  | { kind: 'item'; key: string; offsetWithin: number };

/**
 * High-performance virtual scrolling list.
 *
 * Only renders rows inside the visible viewport plus `overscan` rows above/below.
 * Supports both **fixed-height** rows (set `estimatedRowHeight` to the exact value)
 * and **variable-height** rows, including rows that keep RESIZING after they mount:
 * every mounted row's `height` is re-read each frame and any change is applied to
 * the Fenwick tree as an O(log n) point update.
 *
 * For a growing transcript, pass `keyForItem`. It makes measured heights survive
 * `setItems`, keeps the scroll position anchored while rows above it resize, and
 * re-pins to the bottom when the viewport was already following. `jumpToBottom()`
 * is the instant counterpart to `scrollToBottom()` and is what streaming content
 * should call.
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
 *
 * Accessibility: the container carries the real item count in its accessible NAME,
 * not in `aria-setsize` — that attribute is defined on set members, so on a
 * `role="list"` container it is a disallowed attribute (see `getA11yAttributes`).
 * Rows are yours — give each one `posInSet` (1-based) and `setSize` in its
 * `getA11yAttributes()`, or a screen reader announces the mounted window's size
 * instead of the list's:
 *
 * ```ts
 * renderItem: (item, i) => new Row(item, { posInSet: i + 1, setSize: total })
 * ```
 */
export class VirtualList<T = unknown> extends UIComponent {
  private _items: T[];
  private _renderItem: (item: T, index: number) => Entity;
  private _estH: number;
  private _overscan: number;

  private _keyForItem?: (item: T, index: number) => string;
  private _stickThreshold: number;

  /** Fenwick prefix-sum over row heights (O(log n) scroll math). */
  private _heights: RowHeights;
  /** Which indices have a *measured* (not estimated) height. */
  private _measured: Set<number> = new Set();
  /**
   * Measured height per item key, surviving `setItems` and re-measurement.
   *
   * Keyed rather than indexed so an append or prepend does not invalidate it:
   * the Fenwick tree is index-addressed and gets rebuilt, but the heights it is
   * rebuilt *from* live here. Empty when no `keyForItem` was supplied.
   */
  private _heightByKey: Map<string, number> = new Map();
  /** Key -> current index, rebuilt whenever the item list changes. */
  private _indexByKey: Map<string, number> = new Map();
  /** Currently rendered row entities keyed by item index. */
  private _pool: Map<number, Entity> = new Map();

  private _scrollY = 0;
  private _targetY = 0;
  private _velY = 0;
  private _drag = false;
  private _lastPY = 0;
  /**
   * Whether the viewport was within `stickToBottomThreshold` of the bottom as of the
   * last *user* scroll — i.e. whether the list is currently "following".
   *
   * Latched at the scroll event rather than derived when a row resizes, because the
   * two answer different questions: a resize changes the distance to the bottom
   * without the user having moved, and following should survive that. Scrolling away
   * is the only thing that stops it.
   */
  private _nearBottom = true;

  constructor(opts: VirtualListOptions<T>) {
    super();
    this._items = opts.items;
    this._renderItem = opts.renderItem;
    this._estH = opts.estimatedRowHeight;
    this._overscan = opts.overscan ?? 3;
    this._keyForItem = opts.keyForItem;
    this._stickThreshold = opts.stickToBottomThreshold ?? 48;
    this._heights = new RowHeights(opts.items.length, opts.estimatedRowHeight);
    this._rebuildKeyIndex();
    this.width = opts.width;
    this.height = opts.height;
    this.interactive = true;
    this.clipChildren = true;
    this._bindEvents();
    this._reconcile();
  }

  /**
   * Replace the full item list.
   *
   * Without `keyForItem` this clears the height cache and jumps to the top, which
   * is right for a list that was genuinely replaced. With `keyForItem` the cached
   * height of every surviving key is carried over and the scroll position is
   * anchored, so appending to a transcript neither re-measures nor jumps —
   * `setItems` becomes usable as the incremental append path.
   */
  public setItems(items: T[]): void {
    const keyed = this._keyForItem !== undefined;
    const anchor = keyed ? this._captureAnchor() : null;
    // Which key each pooled entity currently represents, read against the OLD list.
    const prevKeyByIndex = keyed ? new Map<number, string>() : null;
    if (prevKeyByIndex) {
      for (const i of this._pool.keys()) {
        const k = this._keyAt(i);
        if (k !== undefined) prevKeyByIndex.set(i, k);
      }
    }
    this._items = items;
    this._rebuildKeyIndex();
    this._heights = new RowHeights(items.length, this._estH);
    this._measured.clear();
    if (keyed) {
      // Rekey the pool BEFORE anything reads it. `_pool` is index-addressed, so
      // after a prepend entry 0 still holds the old row 0's entity while index 0 now
      // names a different item. Measuring in that state writes each entity's height
      // into the next key's cache slot — every entry wrong, and plausibly so.
      this._rekeyPool(prevKeyByIndex);
      // Reseed from the keyed cache: the tree is index-addressed and had to be
      // rebuilt, but a row's measured height is a property of the row, not of
      // where it currently sits.
      for (let i = 0; i < items.length; i++) {
        const h = this._heightByKey.get(this._keyAt(i)!);
        if (h !== undefined) {
          this._heights.set(i, h);
          this._measured.add(i);
        }
      }
      this._restoreAnchor(anchor);
    } else {
      // Non-keyed path: drop all pooled entities before reconcile so _reconcile
      // remounts everything fresh. Before this fix, _pool was never cleared, so
      // _reconcile reused the pooled entities without calling renderItem again —
      // every overlapping index kept the OLD item's content.
      for (const ent of this._pool.values()) {
        super.remove(ent);
      }
      this._pool.clear();
      this._targetY = 0;
      this._scrollY = 0;
    }
    this._reconcile();
    this.scene?.markDirty({ entity: this.id, reason: 'items-changed' });
  }

  /** The key of item `index`, or `undefined` when no `keyForItem` was supplied. */
  private _keyAt(index: number): string | undefined {
    if (!this._keyForItem) return undefined;
    const item = this._items[index];
    return item === undefined ? undefined : this._keyForItem(item, index);
  }

  /**
   * Move each pooled entity to the index its item now occupies, and drop entities
   * whose item is gone.
   *
   * Without this a prepend leaves the pool describing the previous ordering while
   * every other structure describes the new one, so the row that renders at index 0
   * is the entity built for whatever used to be there.
   */
  private _rekeyPool(prevKeyByIndex: Map<number, string> | null): void {
    if (!prevKeyByIndex) return;
    const moved = new Map<number, Entity>();
    for (const [oldIndex, ent] of this._pool) {
      const key = prevKeyByIndex.get(oldIndex);
      const newIndex = key === undefined ? undefined : this._indexByKey.get(key);
      if (newIndex === undefined) {
        // The item is gone; so is its row.
        super.remove(ent);
        continue;
      }
      moved.set(newIndex, ent);
    }
    this._pool = moved;
  }

  private _rebuildKeyIndex(): void {
    if (!this._keyForItem) return;
    this._indexByKey.clear();
    for (let i = 0; i < this._items.length; i++) {
      const k = this._keyAt(i);
      if (k !== undefined) this._indexByKey.set(k, i);
    }
  }

  /** Scroll to make the row at `index` visible. */
  public scrollToIndex(index: number): void {
    this._targetY = Math.min(this._rowTop(index), this._maxScroll());
    this._latchBottom();
    this.scene?.markDirty();
  }

  public scrollToTop(): void {
    this._targetY = 0;
    this._latchBottom();
    this.scene?.markDirty();
  }

  public scrollToBottom(): void {
    this._targetY = this._maxScroll();
    this._latchBottom();
    this.scene?.markDirty();
  }

  /**
   * Jump to the bottom immediately, without the scroll animation.
   *
   * For content that grows while being followed — a streaming transcript — this is
   * the correct call and {@link scrollToBottom} is not. Retargeting the integrator
   * on every chunk never lets it settle, so the viewport chases the content instead
   * of tracking it; `ScrollView.scrollToBottom` snaps for the same reason.
   */
  public jumpToBottom(): void {
    this._targetY = this._maxScroll();
    this._scrollY = this._targetY;
    this._velY = 0;
    this._latchBottom();
    this._reconcile();
    this.scene?.markDirty({ entity: this.id, reason: 'jump-to-bottom' });
  }

  private _maxScroll(): number {
    return Math.max(0, this._totalH() - this.height);
  }

  /**
   * Record how close the viewport is to the bottom, as of a user scroll.
   *
   * Measured against `_targetY` rather than `_scrollY` because the target is where
   * the user asked to be; mid-animation the current position lags and would read as
   * "not at the bottom" for the whole settle.
   */
  private _latchBottom(): void {
    this._nearBottom = Math.max(0, this._maxScroll() - this._targetY) <= this._stickThreshold;
  }

  /**
   * Where the viewport is now, expressed so it can be re-derived after row heights
   * change. Returns `null` when there is nothing to anchor to.
   */
  private _captureAnchor(): ScrollAnchor | null {
    if (this._nearBottom) {
      // Preserve the gap the user chose, so "following from 30px up" stays 30px up
      // rather than snapping flush to the bottom.
      //
      // The distance is read here, before any height is written, so it is measured
      // against the OLD geometry — which is the point. markstream-vue needs a
      // separately latched exact-bottom flag because it mutates heights eagerly and
      // reconciles scroll in a later frame, letting several resizes land in between;
      // this list captures, mutates and restores as one synchronous unit per frame,
      // so no such window exists. Verified by mutation: replacing `_nearBottom` with
      // a live re-measurement here changes no observable behaviour.
      return {
        kind: 'bottom',
        distanceFromBottom: Math.max(0, this._maxScroll() - this._targetY),
      };
    }
    if (!this._keyForItem) return null;
    const top = this._targetY;
    const index = this._heights.indexAt(top);
    const key = this._keyAt(index);
    if (key === undefined) return null;
    return {
      kind: 'item',
      key,
      offsetWithin: top - this._heights.prefix(index),
    };
  }

  /**
   * Put the viewport back where {@link _captureAnchor} found it, against the NEW
   * geometry — the item branch is a fresh `prefix()`, so the anchored row stays
   * visually still however much the rows above it changed.
   */
  private _restoreAnchor(anchor: ScrollAnchor | null): void {
    if (!anchor) {
      this._clamp();
      if (this._scrollY > this._targetY) this._scrollY = this._targetY;
      return;
    }
    if (anchor.kind === 'bottom') {
      this._targetY = Math.max(0, this._maxScroll() - anchor.distanceFromBottom);
    } else {
      const index = this._indexByKey.get(anchor.key);
      if (index === undefined) {
        // The anchored row is gone; the best available answer is the clamp.
        this._clamp();
        return;
      }
      const rowTop = this._heights.prefix(index);
      // Clamp the intra-row offset: the anchored row may itself have shrunk below
      // the offset that was captured inside it.
      const within = Math.min(anchor.offsetWithin, Math.max(0, this._heights.heightOf(index)));
      this._targetY = rowTop + within;
    }
    this._clamp();
    // Follow with the current position too. Leaving `_scrollY` behind would make
    // every resize spawn a scroll animation, so a steadily growing transcript would
    // animate continuously and never idle.
    this._scrollY = this._targetY;
    this._velY = 0;
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

    // Mount rows first, then measure, then position. Measuring before positioning
    // matters: reading `heightOf(i)` up front and advancing by it meant a row
    // measured on its mount frame positioned every row below it against the stale
    // estimate, so a freshly mounted variable-height row visibly settled one frame
    // late.
    for (let i = s; i <= e; i++) {
      if (!this._pool.has(i)) {
        const ent = this._renderItem(this._items[i], i);
        ent.x = 0;
        ent.width = ent.width || this.width;
        super.add(ent);
        this._pool.set(i, ent);
      }
    }
    this._measureMountedRows();

    let ry = this._rowTop(s);
    for (let i = s; i <= e; i++) {
      this._pool.get(i)!.y = ry - this._scrollY;
      ry += this._heights.heightOf(i);
    }
  }

  /**
   * Re-read the height of every mounted row and push any change into the Fenwick
   * tree, anchoring the viewport across the change.
   *
   * Polling rather than a notification: `Entity.width`/`height` are plain fields
   * with no setter and no dirty flag, so there is nothing to subscribe to, and
   * reading `ent.height` costs exactly what reading a version counter would — the
   * check *is* the work. It is also strictly more general, catching a height change
   * by any mechanism (a streaming Markdown reflow, a caller assigning `height`
   * directly) rather than only the ones that remembered to announce themselves.
   *
   * The no-change path is one Map lookup and one float compare per mounted row
   * (~10-16 of them) and deliberately does NOT mark the scene dirty; a per-frame
   * unconditional `markDirty()` here would defeat the idle throttle exactly as
   * ScrollView's `update()` documents.
   */
  private _measureMountedRows(): void {
    let changed = false;
    let anchor: ScrollAnchor | null = null;
    for (const [i, ent] of this._pool) {
      // `> 0` because an unmeasured row reports 0, and treating that as a
      // measurement would collapse the list to zero height.
      if (ent.height <= 0) continue;
      if (this._heights.heightOf(i) === ent.height) {
        this._measured.add(i);
        continue;
      }
      // Capture the anchor before the first mutation, against the old geometry.
      if (!changed) {
        anchor = this._captureAnchor();
        changed = true;
      }
      this._measured.add(i);
      this._heights.set(i, ent.height);
      const k = this._keyAt(i);
      if (k !== undefined) this._heightByKey.set(k, ent.height);
    }
    if (!changed) return;
    this._restoreAnchor(anchor);
    this.scene?.markDirty({ entity: this.id, reason: 'row-resize' });
  }

  private _clamp(): void {
    const max = Math.max(0, this._totalH() - this.height);
    this._targetY = Math.max(0, Math.min(this._targetY, max));
  }

  private _bindEvents(): void {
    this.on('wheel', (e) => {
      if (e.ctrlKey) return;
      e.preventDefault();
      const deltaY = e.deltaY ?? 0;
      const deltaMode = e.deltaMode ?? 0;
      let scrollDelta = deltaY;
      if (deltaMode === 1) scrollDelta = deltaY * 16;
      else if (deltaMode === 2) scrollDelta = deltaY * this.height;
      this._targetY += scrollDelta;
      this._clamp();
      this._latchBottom();
      // Required, and not redundant with `hasPendingAnimations()`: the loop's
      // `isIdle` check reads `frameHadAnimation`, which is only refreshed during
      // a RENDERED frame's tree walk. Once the scene has gone idle it skips the
      // walk entirely (`onDemand`) or drops to 2 FPS (`always` + autoThrottle),
      // so nothing would ever observe the new `_targetY` and re-arm the loop.
      // markDirty() is what wakes that first frame; every other path that moves
      // `_targetY` (pointermove, scrollTo, setItems) does the same.
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
      this._latchBottom();
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
    // Poll unconditionally, not only while scrolling: a row growing under a
    // stationary viewport is the streaming case, and it is exactly the one a
    // scroll-gated measurement would never see.
    this._measureMountedRows();
    const diff = this._targetY - this._scrollY;
    // dt-aware exponential integrator: the old per-frame gain (0.12) and decay
    // (0.82) are the 60 Hz discretization of a 7.2/s gain and an 84 ms time
    // constant (τ = -16.67/ln(0.82)), and the position step scales by dt/16.67,
    // so the settle trajectory is refresh-rate independent while a 60 Hz tick
    // reproduces the old feel exactly. Same fix class as ScrollView's 0.2.x
    // migration off its hand-rolled per-frame integrator.
    this._velY += diff * 7.2 * (dt / 1000);
    this._velY *= Math.exp(-dt / 84);
    if (Math.abs(this._velY) > 0.05 || Math.abs(diff) > 0.05) {
      this._scrollY += this._velY * (dt / 16.67);
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
      // NOT `setSize`: `aria-setsize` is defined on set MEMBERS, not on the set
      // itself, so putting it on the `role="list"` container is a disallowed
      // attribute (axe `aria-allowed-attr`, critical). The count belongs in the
      // container's accessible name, which the label above already carries, and on
      // each row — see the class doc.
    };
  }

  /**
   * Everything a recycling list makes invisible: which rows are mounted, how many
   * heights are real measurements versus the estimate, and the pool's reuse ratio.
   *
   * This is the component where a generic inspector is least useful — position and
   * size say nothing about whether virtualization is behaving, and the state that
   * would say so (`_pool`, `_measured`, `_scrollY`) is all private.
   */
  public override getDevtoolsDescriptor(): DevtoolsDescriptor {
    const [start, end] = this._visibleRange();
    const total = this._items.length;
    return {
      kind: 'VirtualList',
      groups: [
        {
          label: 'Virtualization',
          fields: [
            {
              label: 'visibleRange',
              value: [start, end],
              hint: 'Inclusive row indices currently mounted, before overscan',
            },
            { label: 'mountedRows', value: this._pool.size, readOnly: true },
            { label: 'totalRows', value: total, readOnly: true },
            {
              label: 'overscan',
              value: this._overscan,
              hint: 'Extra rows mounted beyond the viewport on each side',
            },
            {
              label: 'mountedFraction',
              value: total > 0 ? Math.round((1000 * this._pool.size) / total) / 10 : 0,
              hint: 'Percent of rows mounted; a rising number means virtualization is losing',
              readOnly: true,
            },
          ],
        },
        {
          label: 'Measurement',
          fields: [
            {
              label: 'measuredRows',
              value: this._measured.size,
              hint: 'Rows with a real measured height; the rest use estimatedHeight',
              readOnly: true,
            },
            {
              label: 'estimatedRowHeight',
              value: this._estH,
              hint: 'Matches the constructor option name, used for every unmeasured row',
            },
            {
              label: 'totalHeight',
              value: Math.round(this._heights.total()),
              hint: 'Sum over the Fenwick tree, mixing measured and estimated rows',
              readOnly: true,
            },
            {
              label: 'cachedHeights',
              value: this._heightByKey.size,
              hint: 'Keyed heights surviving setItems; 0 when no keyForItem was given',
              readOnly: true,
            },
          ],
        },
        {
          label: 'Following',
          fields: [
            {
              label: 'keyed',
              value: this._keyForItem !== undefined,
              hint: 'Whether keyForItem was supplied — required for anchoring',
              readOnly: true,
            },
            {
              label: 'nearBottom',
              value: this._nearBottom,
              hint: `Latched at the last scroll: within ${this._stickThreshold}px of the bottom`,
              readOnly: true,
            },
          ],
        },
        {
          label: 'Scroll',
          fields: [
            {
              label: 'scrollY',
              value: Math.round(this._scrollY * 10) / 10,
              readOnly: true,
            },
            {
              label: 'targetY',
              value: Math.round(this._targetY * 10) / 10,
              readOnly: true,
            },
            {
              label: 'velocityY',
              value: Math.round(this._velY * 10) / 10,
              readOnly: true,
            },
            { label: 'dragging', value: this._drag, readOnly: true },
          ],
        },
      ],
      notes:
        this._measured.size < total
          ? [
              `${total - this._measured.size} of ${total} rows still use the estimated height, so totalHeight and scrollbar geometry are approximate until they are scrolled into view.`,
            ]
          : undefined,
    };
  }

  public render(_r: IRenderer): void {
    // clipChildren handles viewport masking; nothing to draw here.
  }
}
