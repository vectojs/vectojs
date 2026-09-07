import { Entity, type A11yAttributes, type LayoutControlledProperty } from '../tree/Entity';
import type { IRenderer } from '../renderer/IRenderer';

/**
 * One item in a {@link VirtualizedSetAggregate}: the stable identity and the
 * accessible name a hotspot announces for it.
 */
export interface VirtualizedSetItem {
  /** Stable identity across re-binds; survives reordering and filtering. */
  id: string;
  /** Accessible name announced for the item. */
  label: string;
}

export interface VirtualizedSetAggregateOptions {
  /** Full item set; the container label always states this count. Default `[]`. */
  items?: VirtualizedSetItem[];
  /** Container name; the count is appended (`'Messages, 10000 items'`). */
  label?: string;
  /** Container role. Default `'list'` (owns `listitem` per `A11Y_REQUIRED_OWNED`). */
  role?: string;
  /** Hotspot role. Default `'listitem'`. */
  itemRole?: string;
  /** Row height in local px; hotspots stack vertically at this stride. Default `28`. */
  rowHeight?: number;
  /** Hotspot pool size. Default: enough slots to cover `height`, at least 1. */
  visibleCapacity?: number;
  /** Container width in local px. Default `0` (set it — a zero box never projects). */
  width?: number;
  /** Container height in local px. Default `0`. */
  height?: number;
  /** Called when an item is activated (Enter/Space/click-through). */
  onActivate?: (item: VirtualizedSetItem, index: number) => void;
}

/**
 * Aggregate semantics for a virtualized set (RFC3 §4.4, CTX-0599).
 *
 * One persistent container (`role` + `aria-label` with the count) plus roving
 * focus plus a small pool of hotspot entities re-bound to whichever items
 * currently occupy each visible slot — O(viewport) DOM nodes for an
 * arbitrarily large dataset. The pattern is the `Tree`/`Table` hotspot
 * precedent (`packages/ui/src/Tree.ts:98-113`, `packages/table/src/Table.ts`):
 * a transparent, focusable child per visible row with a roving `tabIndex` and
 * `pointerEvents: 'none'`, while the parent owns the keyboard model and the
 * pool.
 *
 * Pointer ownership: neither the container nor the hotspots take the pointer
 * (both project `pointer-events: none`), so a real click/drag reaches the
 * owner's canvas handling or an underlying selectable-text mirror underneath.
 * Keyboard focus and AT-synthesized `click` still work — the same contract the
 * `Tree`/`Table` hotspots rely on. A mouse/touch owner forwards its own tap
 * path into {@link activateItem}; `'onDemand'` alone is deliberately not the
 * story here (also `content/reference/core-a11y.md:207-214`).
 *
 * Painting belongs to the owner: `render` is a no-op (like `RowHotspot`), so
 * pair this with canvas-painted rows or subclass and override `render`.
 */
export class VirtualizedSetAggregate extends Entity {
  private _items: VirtualizedSetItem[];
  private _label: string;
  private _role: string;
  private _itemRole: string;
  private _rowHeight: number;
  private _visibleCapacity: number | undefined;
  private _onActivate: ((item: VirtualizedSetItem, index: number) => void) | undefined;
  /** First item index currently bound to the pool (the scroll window). */
  private _visibleStart = 0;
  /** Item id owning the roving tab stop / keyboard focus. */
  private _activeId: string | null = null;
  private _selectedId: string | null = null;
  /** One focusable hotspot per visible slot; re-bound, never rebuilt per item. */
  private _hotspots: AggregateItemHotspot[] = [];

  constructor(opts: VirtualizedSetAggregateOptions = {}) {
    super();
    this._items = opts.items ?? [];
    this._label = opts.label ?? 'Items';
    this._role = opts.role ?? 'list';
    this._itemRole = opts.itemRole ?? 'listitem';
    this._rowHeight = opts.rowHeight ?? 28;
    this._visibleCapacity = opts.visibleCapacity;
    this._onActivate = opts.onActivate;
    this.width = opts.width ?? 0;
    this.height = opts.height ?? 0;
    this.interactive = true;
    this._syncHotspots();
  }

  /** Full item count — the number the container label states. */
  public get itemCount(): number {
    return this._items.length;
  }

  /** Live pool size (bounded by the visible capacity, never by the item count). */
  public get poolSize(): number {
    return this._hotspots.length;
  }

  /** First item index currently bound to the pool. */
  public get visibleStart(): number {
    return this._visibleStart;
  }

  public getA11yAttributes(): A11yAttributes {
    return {
      role: this._role,
      label: `${this._label}, ${this._items.length} items`,
      pointerEvents: 'none',
    };
  }

  public override render(_renderer: IRenderer): void {
    // Intentionally empty: the owner paints the rows; this entity exists for
    // the container mirror plus its pooled hotspots (cf. RowHotspot).
  }

  /** Axis-aligned hit-test against the container box (the `UIComponent` default). */
  public override isPointInside(globalX: number, globalY: number): boolean {
    const local = this.worldToLocal(globalX, globalY);
    if (!local) return false;
    return local.x >= 0 && local.x <= this.width && local.y >= 0 && local.y <= this.height;
  }

  /** Replace the item set; the pool re-binds and the label count follows. */
  public setItems(items: VirtualizedSetItem[]): void {
    this._items = items;
    if (this._activeId !== null && !items.some((item) => item.id === this._activeId)) {
      this._activeId = null;
    }
    if (this._selectedId !== null && !items.some((item) => item.id === this._selectedId)) {
      this._selectedId = null;
    }
    this._visibleStart = Math.max(0, Math.min(this._visibleStart, Math.max(0, items.length - 1)));
    this._syncHotspots();
    this.scene?.markDirty();
  }

  /** Move the pool window to start at `start` (the scroll position). */
  public setVisibleStart(start: number): void {
    const clamped = Math.max(0, Math.min(start, Math.max(0, this._items.length - 1)));
    if (clamped === this._visibleStart) return;
    this._visibleStart = clamped;
    this._syncHotspots();
    this.scene?.markDirty();
  }

  /**
   * Keep one hotspot per visible slot, positioned over it. The pool is sized
   * to the viewport (capacity), each slot re-bound to whatever item currently
   * occupies it — the `Tree._syncHotspots` shape, minus tree structure.
   */
  private _syncHotspots(): void {
    const capacity = this._visibleCapacity ?? Math.max(1, Math.ceil(this.height / this._rowHeight));
    const need = Math.max(0, Math.min(capacity, this._items.length - this._visibleStart));
    while (this._hotspots.length < need) {
      const hotspot = new AggregateItemHotspot(this);
      this._hotspots.push(hotspot);
      this.add(hotspot);
    }
    while (this._hotspots.length > need) {
      const hotspot = this._hotspots.pop()!;
      this.scene?.detachA11y(hotspot);
      this.remove(hotspot);
    }
    for (let slot = 0; slot < need; slot++) {
      const index = this._visibleStart + slot;
      const hotspot = this._hotspots[slot];
      hotspot.bind(index, this._items[index]);
      hotspot.x = 0;
      hotspot.y = slot * this._rowHeight;
      hotspot.width = this.width;
      hotspot.height = this._rowHeight;
    }
  }

  /** Whether `id` owns the roving tab stop: active, else selected, else first. */
  public isTabStop(id: string): boolean {
    const anchor =
      (this._activeId !== null && this._items.some((item) => item.id === this._activeId)
        ? this._activeId
        : null) ??
      (this._selectedId !== null && this._items.some((item) => item.id === this._selectedId)
        ? this._selectedId
        : null) ??
      this._items[0]?.id;
    return id === anchor;
  }

  public isSelected(id: string): boolean {
    return this._selectedId === id;
  }

  /** Item role the hotspots announce (kept on the parent: one source of truth). */
  public get itemRole(): string {
    return this._itemRole;
  }

  /** Activate an item (pointer tap-through or Enter/Space): selects and notifies. */
  public activateItem(id: string, focusIt = false): void {
    const index = this._items.findIndex((item) => item.id === id);
    if (index === -1) return;
    this._activeId = id;
    this._selectedId = id;
    this._onActivate?.(this._items[index], index);
    if (focusIt) this.focusItem(id);
    this.scene?.markDirty();
  }

  /** Move keyboard focus to the hotspot currently bound to `id`, if any. */
  public focusItem(id: string): void {
    this._hotspots.find((hotspot) => hotspot.itemId === id)?.focus();
  }

  /**
   * Aggregate keyboard model: Up/Down move the active item (scrolling the pool
   * window so it stays bound), Home/End jump, Enter/Space activate. The active
   * item is focused as it moves so focus is never stranded on a re-bound slot.
   */
  public handleItemKey(e: KeyboardEvent, id: string): void {
    const index = this._items.findIndex((item) => item.id === id);
    if (index === -1) return;
    let next = -1;
    switch (e.key) {
      case 'ArrowDown':
        next = Math.min(index + 1, this._items.length - 1);
        break;
      case 'ArrowUp':
        next = Math.max(index - 1, 0);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = this._items.length - 1;
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        this.activateItem(id, true);
        return;
      default:
        return;
    }
    e.preventDefault();
    this._activeId = this._items[next].id;
    this._ensureVisible(next);
    this.focusItem(this._activeId);
    this.scene?.markDirty();
  }

  /** Scroll the pool window just enough to keep `index` bound. */
  private _ensureVisible(index: number): void {
    const capacity = this._visibleCapacity ?? Math.max(1, Math.ceil(this.height / this._rowHeight));
    if (index < this._visibleStart) this.setVisibleStart(index);
    else if (index >= this._visibleStart + capacity) {
      this.setVisibleStart(index - capacity + 1);
    } else {
      this._syncHotspots();
    }
  }

  public override update(_dt: number, _time: number): void {
    super.update(_dt, _time);
    this._syncHotspots();
  }
}

/**
 * A transparent, focusable hotspot over one visible aggregate slot. The
 * {@link VirtualizedSetAggregate} paints nothing itself; this exists so the
 * a11y/automation layer projects a real item node (with `aria-posinset` /
 * `aria-setsize` so a virtualized subset never announces "item 3 of 12" for
 * rows 40–52 of 10,000) and a roving tabindex a keyboard user can drive
 * (WCAG 4.1.2 / 2.1.1).
 */
class AggregateItemHotspot extends Entity {
  public itemId = '';
  private _index = 0;
  private _label = '';

  constructor(private readonly aggregate: VirtualizedSetAggregate) {
    super();
    this.interactive = true;
    this.on('click', () => this.aggregate.activateItem(this.itemId, true));
    this.on('keydown', (e: KeyboardEvent) => this.aggregate.handleItemKey(e, this.itemId));
  }

  public bind(index: number, item: VirtualizedSetItem): void {
    this._index = index;
    this.itemId = item.id;
    this._label = item.label;
  }

  /** The aggregate positions and sizes one pooled hotspot per visible slot. */
  public override getLayoutControlledProperties(): ReadonlyArray<LayoutControlledProperty> {
    return ['x', 'y', 'width', 'height'];
  }

  public override getA11yAttributes(): A11yAttributes {
    return {
      role: this.aggregate.itemRole,
      label: this._label,
      // 1-based position within the FULL set, not the pool: without these a
      // virtualized window announces the pool position as the set position.
      posInSet: this._index + 1,
      setSize: this.aggregate.itemCount,
      selected: this.aggregate.isSelected(this.itemId),
      // Roving tabindex: only the active item is a tab stop; arrows move within.
      tabIndex: this.aggregate.isTabStop(this.itemId) ? 0 : -1,
      // The owner keeps the pointer (canvas handling or an underlying
      // selectable-text mirror); this hotspot exists for semantics + keyboard
      // focus, so it opts out of hit-testing. Keyboard focus and
      // AT-synthesized `click` still work under `pointer-events:none`.
      pointerEvents: 'none',
    };
  }

  public override render(): void {
    /* invisible — the owner paints the rows */
  }

  /** Axis-aligned hit-test against the hotspot slot (the `UIComponent` default). */
  public override isPointInside(globalX: number, globalY: number): boolean {
    const local = this.worldToLocal(globalX, globalY);
    if (!local) return false;
    return local.x >= 0 && local.x <= this.width && local.y >= 0 && local.y <= this.height;
  }
}
