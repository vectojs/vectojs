import { Entity, IRenderer } from '@vectojs/core';
import { UIComponent } from './UIComponent';

export interface PanelGroupOptions {
  direction: 'horizontal' | 'vertical';
  width: number;
  height: number;
  /** Width/height of the drag handle in pixels. Default `4`. */
  handleSize?: number;
  /** Handle color. Default `'rgba(255,255,255,0.12)'`. */
  handleColor?: string;
  /** Handle color when hovered/dragged. Default `'rgba(0,240,255,0.4)'`. */
  handleHoverColor?: string;
}

export interface PanelOptions {
  /** Minimum size in pixels along the group's main axis. Default `60`. */
  minSize?: number;
  /**
   * Initial fractional size (0..1) relative to the group's available space.
   * If omitted, the remaining space is distributed evenly among un-sized panels.
   */
  defaultSize?: number;
}

/**
 * Draggable divider between two panels in a {@link PanelGroup}.
 * Invokes the provided resize callback on drag.
 */
export class PanelResizeHandle extends UIComponent {
  public direction: 'horizontal' | 'vertical';
  private _drag = false;
  private _lastPos = 0;
  private _hovered = false;
  private _color: string;
  private _hoverColor: string;

  constructor(
    dir: 'horizontal' | 'vertical',
    size: number,
    color: string,
    hoverColor: string,
    onResize: (delta: number) => void,
  ) {
    super('PanelResizeHandle');
    this.direction = dir;
    this._color = color;
    this._hoverColor = hoverColor;
    this.width = dir === 'horizontal' ? size : 0;
    this.height = dir === 'vertical' ? size : 0;
    this.interactive = true;

    this.on('pointerdown', (e: { clientX?: number; clientY?: number }) => {
      this._drag = true;
      this._lastPos = dir === 'horizontal' ? (e.clientX ?? 0) : (e.clientY ?? 0);
    });
    this.on('pointermove', (e: { clientX?: number; clientY?: number }) => {
      if (!this._drag) return;
      const pos = dir === 'horizontal' ? (e.clientX ?? 0) : (e.clientY ?? 0);
      const delta = pos - this._lastPos;
      this._lastPos = pos;
      if (delta !== 0) onResize(delta);
      this.scene?.markDirty();
    });
    const end = () => {
      this._drag = false;
    };
    this.on('pointerup', end);
    this.on('pointerleave', end);
    this.on('hover', () => {
      this._hovered = true;
      this.scene?.markDirty();
    });
    this.on('pointerleave', () => {
      this._hovered = false;
    });
  }

  public render(r: IRenderer): void {
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, 2);
    r.fill(this._hovered || this._drag ? this._hoverColor : this._color);
  }
}

/**
 * A content viewport panel inside a {@link PanelGroup}.
 * Use {@link setContent} to place an entity inside the clipped viewport.
 */
export class Panel extends UIComponent {
  public minSize: number;
  public defaultSize: number | undefined;
  private _content: Entity | null = null;

  constructor(opts: PanelOptions = {}) {
    super('Panel');
    this.minSize = opts.minSize ?? 60;
    this.defaultSize = opts.defaultSize;
    this.clipChildren = true;
    this.interactive = false;
  }

  /** Replace the panel's content entity. */
  public setContent(content: Entity): this {
    if (this._content) super.remove(this._content);
    this._content = content;
    content.x = 0;
    content.y = 0;
    super.add(content);
    return this;
  }

  public render(_r: IRenderer): void {
    // Transparent by default; add background override in subclass if needed.
  }
}

/**
 * Splits available space among {@link Panel} children with draggable
 * {@link PanelResizeHandle} dividers. Supports arbitrary nesting:
 * pass a `PanelGroup` as content to a `Panel`.
 *
 * @example
 * const group = new PanelGroup({ direction: 'horizontal', width: 1200, height: 800 });
 * group
 *   .addPanel(new Panel({ minSize: 160, defaultSize: 0.2 }))
 *   .addPanel(new Panel({ minSize: 300 }))
 *   .addPanel(new Panel({ minSize: 240, defaultSize: 0.25 }));
 * scene.add(group.setPosition(0, 0));
 */
export class PanelGroup extends UIComponent {
  public direction: 'horizontal' | 'vertical';
  private _panels: Panel[] = [];
  private _handles: PanelResizeHandle[] = [];
  private _sizes: number[] = [];
  private _hSize: number;
  private _hColor: string;
  private _hHoverColor: string;

  constructor(opts: PanelGroupOptions) {
    super('PanelGroup');
    this.width = opts.width;
    this.height = opts.height;
    this.direction = opts.direction;
    this._hSize = opts.handleSize ?? 4;
    this._hColor = opts.handleColor ?? 'rgba(255,255,255,0.12)';
    this._hHoverColor = opts.handleHoverColor ?? 'rgba(0,240,255,0.4)';
  }

  /**
   * Add a panel.
   * A {@link PanelResizeHandle} is inserted automatically before it
   * (except for the first panel).
   */
  public addPanel(panel: Panel): this {
    if (this._panels.length > 0) {
      const idx = this._panels.length - 1;
      const handle = new PanelResizeHandle(
        this.direction,
        this._hSize,
        this._hColor,
        this._hHoverColor,
        (delta: number) => this._onResize(idx, delta),
      );
      this._handles.push(handle);
      super.add(handle);
    }
    this._panels.push(panel);
    super.add(panel);
    this._initSizes();
    this._layout();
    return this;
  }

  /** Update the group's canvas dimensions (e.g., on window resize). */
  public resize(w: number, h: number): void {
    this.width = w;
    this.height = h;
    this._initSizes();
    this._layout();
    this.scene?.markDirty();
  }

  private _avail(): number {
    return (
      (this.direction === 'horizontal' ? this.width : this.height) -
      this._handles.length * this._hSize
    );
  }

  private _initSizes(): void {
    const avail = this._avail();
    const n = this._panels.length;
    if (this._sizes.length === n) return; // already initialised
    this._sizes = [];
    let rem = avail;
    const assigned = Array(n).fill(false) as boolean[];

    for (let i = 0; i < n; i++) {
      if (this._panels[i].defaultSize !== undefined) {
        this._sizes[i] = Math.max(this._panels[i].minSize, this._panels[i].defaultSize! * avail);
        rem -= this._sizes[i];
        assigned[i] = true;
      }
    }
    const unassigned = assigned.filter((v) => !v).length;
    const share = unassigned > 0 ? rem / unassigned : 0;
    for (let i = 0; i < n; i++) {
      if (!assigned[i]) this._sizes[i] = Math.max(this._panels[i].minSize, share);
    }
  }

  private _onResize(idx: number, delta: number): void {
    const a = idx;
    const b = idx + 1;
    this._sizes[a] = Math.max(this._panels[a].minSize, this._sizes[a] + delta);
    this._sizes[b] = Math.max(this._panels[b].minSize, this._sizes[b] - delta);
    this._layout();
    this.scene?.markDirty();
  }

  private _layout(): void {
    const isH = this.direction === 'horizontal';
    const cross = isH ? this.height : this.width;
    let pos = 0;

    for (let i = 0; i < this._panels.length; i++) {
      const p = this._panels[i];
      const sz = this._sizes[i] ?? 0;
      if (isH) {
        p.x = pos;
        p.y = 0;
        p.width = sz;
        p.height = cross;
      } else {
        p.x = 0;
        p.y = pos;
        p.width = cross;
        p.height = sz;
      }
      pos += sz;

      if (i < this._handles.length) {
        const h = this._handles[i];
        if (isH) {
          h.x = pos;
          h.y = 0;
          h.width = this._hSize;
          h.height = cross;
        } else {
          h.x = 0;
          h.y = pos;
          h.width = cross;
          h.height = this._hSize;
        }
        pos += this._hSize;
      }
    }
  }

  public render(_r: IRenderer): void {
    // Transparent container; children handle their own rendering.
  }
}
