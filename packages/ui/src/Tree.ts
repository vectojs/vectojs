import { IRenderer, A11yAttributes } from '@vectojs/core';
import { UIComponent } from './UIComponent';

export interface TreeNode {
  id: string;
  label: string;
  /** Optional icon character (emoji, nerd-font glyph, etc.) */
  icon?: string;
  /** Optional icon color; falls back to the tree's text color when unset (material-style file icons). */
  iconColor?: string;
  /**
   * Array of children = **eager** loading (all nodes loaded upfront).
   * Function = **lazy** loading (called once on first expand).
   */
  children?: TreeNode[] | (() => Promise<TreeNode[]>);
}

interface FlatRow {
  node: TreeNode;
  depth: number;
  expanded: boolean;
  loading: boolean;
  hasChildren: boolean;
}

export interface TreeViewOptions {
  nodes: TreeNode[];
  width: number;
  height: number;
  rowHeight?: number;
  font?: string;
  color?: string;
  selectedColor?: string;
  hoverColor?: string;
  onSelect?: (node: TreeNode) => void;
  onExpand?: (node: TreeNode) => void;
}

/**
 * Hierarchical tree view with virtual row rendering.
 * Supports both **eager** (`TreeNode[]`) and **lazy** (`() => Promise<TreeNode[]>`)
 * child loading.
 *
 * @example
 * const tree = new TreeView({
 *   nodes: fileSystemNodes,
 *   width: 240,
 *   height: 600,
 *   onSelect: (node) => openFile(node.id),
 * });
 * scene.add(tree.setPosition(0, 0));
 */
/** Max pointer travel (px) between down and up that still counts as a tap
 *  (toggles a row) rather than a drag-scroll. */
const TREE_TAP_SLOP = 6;

/**
 * A transparent, focusable hotspot over one visible tree row. The {@link TreeView}
 * paints rows on canvas; this exists so the a11y/automation layer projects a real
 * `role="treeitem"` (with `aria-level`, `aria-expanded`, `aria-selected` and a
 * roving tabindex) that a screen reader and keyboard user can operate
 * (WCAG 4.1.2 / 2.1.1). One hotspot is pooled per on-screen row (the tree is
 * virtualized), re-bound to whichever node currently occupies that slot.
 */
class TreeItemHotspot extends UIComponent {
  public nodeId = '';
  private label = '';
  private level = 1;
  private expandable = false;
  private expandedState = false;

  constructor(private tree: TreeView) {
    super();
    this.interactive = true;
    this.on('click', () => this.tree.activateNode(this.nodeId, true));
    this.on('keydown', (e: KeyboardEvent) => this.tree.handleTreeKey(e, this.nodeId));
  }

  public bind(
    nodeId: string,
    label: string,
    level: number,
    expandable: boolean,
    expanded: boolean,
  ): void {
    this.nodeId = nodeId;
    this.label = label;
    this.level = level;
    this.expandable = expandable;
    this.expandedState = expanded;
  }

  public getA11yAttributes(): A11yAttributes {
    return {
      role: 'treeitem',
      label: this.label,
      level: this.level,
      // aria-expanded only applies to parent items.
      expanded: this.expandable ? this.expandedState : undefined,
      selected: this.tree.isSelected(this.nodeId),
      // Roving tabindex: only the active row is a tab stop; arrows move within.
      tabIndex: this.tree.isTabStop(this.nodeId) ? 0 : -1,
      // The TreeView owns mouse handling (tap-to-toggle + drag-to-scroll); this
      // hotspot exists for semantics + keyboard focus, so it opts out of pointer
      // hit-testing so a real click/drag reaches the tree. Keyboard focus and
      // AT-synthesized `click` still work under `pointer-events:none`.
      pointerEvents: 'none',
    };
  }

  public render(): void {
    /* invisible — TreeView paints the rows */
  }
}

export class TreeView extends UIComponent {
  private _roots: TreeNode[];
  private _rows: FlatRow[] = [];
  private _expanded = new Set<string>();
  private _loaded = new Map<string, TreeNode[]>();
  private _loading = new Set<string>();
  private _selectedId: string | null = null;
  /** Node id that currently owns the roving tab stop / keyboard focus. */
  private _activeId: string | null = null;
  /** Pool of one focusable `role="treeitem"` hotspot per visible row. */
  private _hotspots: TreeItemHotspot[] = [];
  private _hoverIdx = -1;
  private _scrollY = 0;
  private _targetY = 0;
  private _velY = 0;
  private _rh: number;
  /** Drag-to-scroll state. `_downY` is the pointerdown localY; a pointerup that
   *  moved less than {@link TREE_TAP_SLOP} from it counts as a tap (toggles the
   *  row) rather than a scroll drag. */
  private _drag = false;
  private _lastPY = 0;
  private _downY = 0;
  private _dragMoved = false;
  private _font: string;
  private _color: string;
  private _selColor: string;
  private _hovColor: string;
  private _onSelect?: (n: TreeNode) => void;
  private _onExpand?: (n: TreeNode) => void;

  constructor(opts: TreeViewOptions) {
    super();
    this._roots = opts.nodes;
    this.width = opts.width;
    this.height = opts.height;
    this._rh = opts.rowHeight ?? 28;
    this._font = opts.font ?? '13px monospace';
    this._color = opts.color ?? '#e2e8f0';
    this._selColor = opts.selectedColor ?? 'rgba(0,240,255,0.18)';
    this._hovColor = opts.hoverColor ?? 'rgba(255,255,255,0.06)';
    this._onSelect = opts.onSelect;
    this._onExpand = opts.onExpand;
    this.interactive = true;
    this.clipChildren = true;
    this._buildRows();
    this._bind();
  }

  /** Replace all root nodes and reset state. */
  public setNodes(nodes: TreeNode[]): void {
    this._roots = nodes;
    this._expanded.clear();
    this._loaded.clear();
    this._selectedId = null;
    this._buildRows();
    // The old offset can sit past the new content height; `update()` settles
    // onto the stale `_targetY`, `_visibleRange()` then returns start > end and
    // `_syncHotspots` pops every hotspot — a blank, untappable control with no
    // recovery path on touch (wheel/drag are the only other clamp sites).
    this._clamp();
    this._scrollY = this._targetY;
    // The highlight may point at an id that no longer exists; it is guarded on
    // read but stale — drop it so the first render is consistent.
    this._activeId = null;
    this.scene?.markDirty();
  }

  private _buildRows(): void {
    this._rows = [];
    const walk = (nodes: TreeNode[], depth: number) => {
      for (const node of nodes) {
        const lazy = typeof node.children === 'function';
        const eager = Array.isArray(node.children) && node.children.length > 0;
        const hasChildren = lazy || eager || this._loaded.has(node.id);
        const expanded = this._expanded.has(node.id);
        const loading = this._loading.has(node.id);
        this._rows.push({ node, depth, expanded, loading, hasChildren });
        if (expanded) {
          const cached = this._loaded.get(node.id);
          if (cached) walk(cached, depth + 1);
          else if (Array.isArray(node.children)) walk(node.children, depth + 1);
        }
      }
    };
    walk(this._roots, 0);
  }

  private async _toggle(idx: number): Promise<void> {
    const row = this._rows[idx];
    if (!row) return;

    if (!row.hasChildren) {
      this._selectedId = row.node.id;
      this._onSelect?.(row.node);
      this.scene?.markDirty();
      return;
    }

    const id = row.node.id;
    if (this._expanded.has(id)) {
      this._expanded.delete(id);
    } else {
      this._expanded.add(id);
      this._onExpand?.(row.node);
      // Trigger lazy load on first expand
      if (typeof row.node.children === 'function' && !this._loaded.has(id)) {
        // Tracked on the TreeView itself, not the FlatRow object: a sibling
        // lazy load resolving in the meantime calls _buildRows(), which
        // replaces `this._rows` with fresh objects — mutating `row.loading`
        // directly would silently stop affecting anything the moment that
        // happens, since `row` still points at the old, now-detached object.
        this._loading.add(id);
        this._buildRows();
        this.scene?.markDirty();
        try {
          const children = await (row.node.children as () => Promise<TreeNode[]>)();
          this._loaded.set(id, children);
        } catch {
          // A rejected lazy load must not strand the row in the loading state,
          // and the rejection must be handled rather than surfacing as an
          // unhandled promise rejection. Collapse the row so a retry is one
          // click away (the next expand re-attempts the load).
          this._expanded.delete(id);
        } finally {
          this._loading.delete(id);
        }
      }
    }
    this._buildRows();
    this.scene?.markDirty();
  }

  private _bind(): void {
    this.on('wheel', (e) => {
      e.preventDefault();
      const deltaY = e.deltaY ?? 0;
      const deltaMode = e.deltaMode ?? 0;
      let scrollDelta = deltaY;
      if (deltaMode === 1) scrollDelta = deltaY * 16;
      else if (deltaMode === 2) scrollDelta = deltaY * this.height;
      this._targetY += scrollDelta;
      this._clamp();
      this.scene?.markDirty();
    });
    // Pointer handling does double duty: a tap toggles a row, a drag scrolls.
    // Toggling is deferred to pointerup so a touch drag-scroll doesn't
    // accidentally expand/collapse the row the finger landed on — the toggle
    // fires only if the pointer moved less than TREE_TAP_SLOP (a tap).
    this.on('pointerdown', (e: { localY?: number }) => {
      if (e.localY === undefined) return;
      this._drag = true;
      this._dragMoved = false;
      this._lastPY = e.localY;
      this._downY = e.localY;
    });
    this.on('pointermove', (e: { localY?: number }) => {
      if (e.localY === undefined) return;
      const ly = e.localY;
      this._hoverIdx = Math.floor((ly + this._scrollY) / this._rh);
      if (this._drag) {
        if (Math.abs(ly - this._downY) > TREE_TAP_SLOP) this._dragMoved = true;
        this._targetY += this._lastPY - ly; // finger down → reveal earlier rows
        this._lastPY = ly;
        this._clamp();
      }
      this.scene?.markDirty();
    });
    this.on('pointerup', (e: { localY?: number }) => {
      const wasTap = this._drag && !this._dragMoved;
      this._drag = false;
      if (!wasTap || e.localY === undefined) return;
      const idx = Math.floor((e.localY + this._scrollY) / this._rh);
      if (idx >= 0 && idx < this._rows.length) void this._toggle(idx);
    });
    this.on('pointerleave', () => {
      this._drag = false;
      this._hoverIdx = -1;
      this.scene?.markDirty();
    });
  }

  private _clamp(): void {
    const max = Math.max(0, this._rows.length * this._rh - this.height);
    this._targetY = Math.max(0, Math.min(this._targetY, max));
  }

  public override update(dt: number, time: number): void {
    super.update(dt, time);
    const diff = this._targetY - this._scrollY;
    // dt-aware exponential integrator (mirrors VirtualList): the old per-frame
    // gain (0.12) and decay (0.82) are the 60 Hz discretization of a 7.2/s
    // gain and an 84 ms time constant (τ = -16.67/ln(0.82)); the position step
    // scales by dt/16.67. Settle trajectory is refresh-rate independent, and a
    // 60 Hz tick reproduces the old feel exactly.
    this._velY += diff * 7.2 * (dt / 1000);
    this._velY *= Math.exp(-dt / 84);
    if (Math.abs(this._velY) > 0.05 || Math.abs(diff) > 0.05) {
      this._scrollY += this._velY * (dt / 16.67);
      this.scene?.markDirty();
    } else {
      this._scrollY = this._targetY;
      this._velY = 0;
    }
    this._syncHotspots();
  }

  /** First/last row index visible in the viewport (± one row of overscan). */
  private _visibleRange(): [number, number] {
    const start = Math.max(0, Math.floor(this._scrollY / this._rh) - 1);
    const end = Math.min(
      this._rows.length - 1,
      Math.ceil((this._scrollY + this.height) / this._rh),
    );
    return [start, end];
  }

  /**
   * Keep one `role="treeitem"` hotspot per visible row, positioned over it. The
   * tree is virtualized, so the pool is sized to the viewport and each slot is
   * re-bound to whatever node currently occupies it.
   */
  private _syncHotspots(): void {
    if (this._rows.length === 0) {
      if (this._hotspots.length) {
        for (const h of this._hotspots) {
          this.scene?.detachA11y?.(h);
          this.remove(h);
        }
        this._hotspots = [];
      }
      return;
    }
    const [start, end] = this._visibleRange();
    const need = end - start + 1;
    // Grow / shrink the pool to the visible-row count.
    while (this._hotspots.length < need) {
      const h = new TreeItemHotspot(this);
      this._hotspots.push(h);
      this.add(h);
    }
    while (this._hotspots.length > need) {
      const h = this._hotspots.pop()!;
      this.scene?.detachA11y?.(h);
      this.remove(h);
    }
    for (let slot = 0; slot < need; slot++) {
      const i = start + slot;
      const row = this._rows[i];
      const h = this._hotspots[slot];
      h.bind(row.node.id, row.node.label, row.depth + 1, row.hasChildren, row.expanded);
      h.x = 0;
      h.y = i * this._rh - this._scrollY;
      h.width = this.width;
      h.height = this._rh;
    }
  }

  /** Whether `id` is the roving tab stop: the active node, else the selected
   *  one, else the first row. */
  public isTabStop(id: string): boolean {
    const anchor =
      (this._activeId && this._rows.some((r) => r.node.id === this._activeId) && this._activeId) ||
      (this._selectedId &&
        this._rows.some((r) => r.node.id === this._selectedId) &&
        this._selectedId) ||
      this._rows[0]?.node.id;
    return id === anchor;
  }

  public isSelected(id: string): boolean {
    return this._selectedId === id;
  }

  /** Activate a node (pointer click or Enter/Space): toggles a parent, selects a
   *  leaf. Mirrors the pointer tap path but also tracks the active row. */
  public activateNode(id: string, focusIt = false): void {
    const idx = this._rows.findIndex((r) => r.node.id === id);
    if (idx === -1) return;
    this._activeId = id;
    void this._toggle(idx);
    if (focusIt) this._focusNode(id);
  }

  /**
   * Tree keyboard model (WCAG tree pattern): Down/Up move the active row;
   * Right expands a collapsed parent then steps into the first child; Left
   * collapses an expanded parent then steps to the parent row; Home/End jump to
   * the first/last row; Enter/Space activate (toggle/select). The active row is
   * scrolled into view and focused as it moves.
   */
  public handleTreeKey(e: KeyboardEvent, fromId: string): void {
    const keys = [
      'ArrowDown',
      'ArrowUp',
      'ArrowRight',
      'ArrowLeft',
      'Home',
      'End',
      'Enter',
      ' ',
      'Spacebar',
    ];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const idx = this._rows.findIndex((r) => r.node.id === fromId);
    if (idx === -1) return;
    const row = this._rows[idx];

    switch (e.key) {
      case 'ArrowDown':
        this._focusIndex(idx + 1);
        break;
      case 'ArrowUp':
        this._focusIndex(idx - 1);
        break;
      case 'Home':
        this._focusIndex(0);
        break;
      case 'End':
        this._focusIndex(this._rows.length - 1);
        break;
      case 'ArrowRight':
        if (row.hasChildren && !row.expanded) {
          this.activateNode(fromId, true); // expand
        } else if (row.hasChildren && row.expanded) {
          this._focusIndex(idx + 1); // into first child
        }
        break;
      case 'ArrowLeft':
        if (row.hasChildren && row.expanded) {
          this.activateNode(fromId, true); // collapse
        } else {
          // Step to the parent row (nearest shallower ancestor above).
          for (let j = idx - 1; j >= 0; j--) {
            if (this._rows[j].depth < row.depth) {
              this._focusIndex(j);
              break;
            }
          }
        }
        break;
      case 'Enter':
      case ' ':
      case 'Spacebar':
        this.activateNode(fromId, true);
        break;
    }
  }

  private _focusIndex(idx: number): void {
    if (idx < 0 || idx >= this._rows.length) return;
    const id = this._rows[idx].node.id;
    this._activeId = id;
    this._scrollIndexIntoView(idx);
    this._syncHotspots();
    this._focusNode(id);
    this.scene?.markDirty();
  }

  /** Snap (not spring) the row into the viewport so its hotspot is positioned
   *  before we move DOM focus to it. */
  private _scrollIndexIntoView(idx: number): void {
    const top = idx * this._rh;
    const bottom = top + this._rh;
    if (top < this._scrollY) {
      this._scrollY = this._targetY = top;
    } else if (bottom > this._scrollY + this.height) {
      this._scrollY = this._targetY = bottom - this.height;
    }
    this._clamp();
    if (this._scrollY > this._targetY) this._scrollY = this._targetY;
  }

  private _focusNode(id: string): void {
    this._hotspots.find((h) => h.nodeId === id)?.focus();
  }

  /**
   * Keep the hand-rolled scroll integrator visible to the Scene's idle
   * throttle / onDemand skip — see the identical override in VirtualList.
   */
  public override hasPendingAnimations(): boolean {
    return (
      super.hasPendingAnimations() ||
      Math.abs(this._targetY - this._scrollY) > 0.05 ||
      Math.abs(this._velY) > 0.05
    );
  }

  public render(r: IRenderer): void {
    const startIdx = Math.max(0, Math.floor(this._scrollY / this._rh) - 1);
    const endIdx = Math.min(
      this._rows.length - 1,
      Math.ceil((this._scrollY + this.height) / this._rh),
    );

    for (let i = startIdx; i <= endIdx; i++) {
      const row = this._rows[i];
      const y = i * this._rh - this._scrollY;
      const indent = row.depth * 16 + 8;

      // Selection / hover backgrounds
      if (row.node.id === this._selectedId) {
        r.beginPath();
        r.roundRect(0, y, this.width, this._rh, 4);
        r.fill(this._selColor);
      } else if (i === this._hoverIdx) {
        r.beginPath();
        r.roundRect(0, y, this.width, this._rh, 4);
        r.fill(this._hovColor);
      }

      // Expand/collapse arrow
      if (row.hasChildren) {
        const arrow = row.loading ? '⏳' : row.expanded ? '▾' : '▸';
        r.fillText(arrow, indent, y + this._rh / 2 + 4, '11px monospace', 'rgba(255,255,255,0.5)');
      }

      // Icon + label
      const lx = indent + (row.hasChildren ? 16 : 0);
      if (row.node.icon)
        r.fillText(
          row.node.icon,
          lx,
          y + this._rh / 2 + 4,
          this._font,
          row.node.iconColor ?? this._color,
        );
      r.fillText(
        row.node.label,
        lx + (row.node.icon ? 20 : 0),
        y + this._rh / 2 + 4,
        this._font,
        this._color,
      );
    }
  }

  public getA11yAttributes(): A11yAttributes {
    return { role: 'tree', label: 'Tree view' };
  }
}
