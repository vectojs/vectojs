import { IRenderer, A11yAttributes } from '@vectojs/core';
import { UIComponent } from './UIComponent';

export interface TreeNode {
  id: string;
  label: string;
  /** Optional icon character (emoji, nerd-font glyph, etc.) */
  icon?: string;
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
export class TreeView extends UIComponent {
  private _roots: TreeNode[];
  private _rows: FlatRow[] = [];
  private _expanded = new Set<string>();
  private _loaded = new Map<string, TreeNode[]>();
  private _selectedId: string | null = null;
  private _hoverIdx = -1;
  private _scrollY = 0;
  private _targetY = 0;
  private _velY = 0;
  private _rh: number;
  private _font: string;
  private _color: string;
  private _selColor: string;
  private _hovColor: string;
  private _onSelect?: (n: TreeNode) => void;
  private _onExpand?: (n: TreeNode) => void;

  constructor(opts: TreeViewOptions) {
    super('TreeView');
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
        this._rows.push({ node, depth, expanded, loading: false, hasChildren });
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
        row.loading = true;
        this.scene?.markDirty();
        const children = await (row.node.children as () => Promise<TreeNode[]>)();
        this._loaded.set(id, children);
        row.loading = false;
      }
    }
    this._buildRows();
    this.scene?.markDirty();
  }

  private _bind(): void {
    this.on('wheel', (e: WheelEvent) => {
      e.preventDefault();
      this._targetY += e.deltaY;
      this._clamp();
      this.scene?.markDirty();
    });
    this.on('pointerdown', (e: { localY?: number }) => {
      if (e.localY === undefined) return;
      const ly = e.localY;
      const idx = Math.floor((ly + this._scrollY) / this._rh);
      if (idx >= 0 && idx < this._rows.length) void this._toggle(idx);
    });
    this.on('pointermove', (e: { localY?: number }) => {
      if (e.localY === undefined) return;
      const ly = e.localY;
      this._hoverIdx = Math.floor((ly + this._scrollY) / this._rh);
      this.scene?.markDirty();
    });
    this.on('pointerleave', () => {
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
    this._velY += diff * 0.12;
    this._velY *= 0.82;
    if (Math.abs(this._velY) > 0.05 || Math.abs(diff) > 0.05) {
      this._scrollY += this._velY;
      this.scene?.markDirty();
    } else {
      this._scrollY = this._targetY;
    }
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
        r.fillText(row.node.icon, lx, y + this._rh / 2 + 4, this._font, this._color);
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
