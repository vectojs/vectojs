import { Entity, IRenderer, A11yAttributes, VectoJSEvent, type Scene } from '@vectojs/core';
import { Overlay } from './Overlay';
import { measureText } from './measure';

let nextContextMenuId = 1;

export interface ContextMenuItem {
  /** Display label. Use with `separator: false` (default). */
  label?: string;
  /** Keyboard shortcut hint rendered flush-right. */
  shortcut?: string;
  /** Single-character icon (emoji, nerd-font glyph, etc.) shown left of the label. */
  icon?: string;
  /** Called when the user clicks a non-disabled leaf item. */
  onClick?: () => void;
  /** Grey out and make the item non-interactive. */
  disabled?: boolean;
  /** Render a horizontal rule instead of a menu item. */
  separator?: boolean;
  /** Nested submenu opened on click. */
  children?: ContextMenuItem[];
}

export interface ContextMenuOptions {
  items: ContextMenuItem[];
  /** Panel width. Default `220`. */
  width?: number;
  font?: string;
  color?: string;
  disabledColor?: string;
  bg?: string;
  hoverBg?: string;
  borderColor?: string;
  /** Row height for non-separator items. Default `32`. */
  itemHeight?: number;
  /** Height of separator rows. Default `9`. */
  separatorHeight?: number;
}

/**
 * A right-click context menu with separator support and nested submenus.
 *
 * @example
 * const menu = new ContextMenu({
 *   items: [
 *     { label: 'Cut',   icon: '✂️', shortcut: 'Ctrl+X', onClick: () => cut() },
 *     { label: 'Copy',  icon: '📋', shortcut: 'Ctrl+C', onClick: () => copy() },
 *     { separator: true },
 *     { label: 'Delete', onClick: () => del(), disabled: true },
 *   ],
 * });
 * scene.add(menu);
 * entity.on('pointerdown', (event) => {
 *   const pointer = event.nativeEvent as PointerEvent | undefined;
 *   if (pointer?.button !== 2 || event.sceneX === undefined || event.sceneY === undefined) return;
 *   menu.showAtPoint(event.sceneX, event.sceneY);
 * });
 */
export class ContextMenu extends Overlay {
  private _items: ContextMenuItem[];
  private _font: string;
  private _textColor: string;
  private _disColor: string;
  private _bg: string;
  private _hoverBg: string;
  private _border: string;
  private _iH: number;
  private _sH: number;
  private _hoverIdx = -1;
  private _submenu: ContextMenu | null = null;
  private _parentMenu: ContextMenu | null = null;
  /** Which item's `children` `_submenu` currently represents, if any. */
  private _submenuFor: ContextMenuItem | null = null;
  private _opts: ContextMenuOptions;
  /** Full-screen invisible entity mounted behind the menu while open, so a
   * click anywhere outside it closes the menu — the way every native context
   * menu behaves. Without this the menu only ever closed by selecting one of
   * its own (non-disabled) items. */
  private _backdrop: Entity | null = null;

  constructor(opts: ContextMenuOptions) {
    const iH = opts.itemHeight ?? 32;
    const sH = opts.separatorHeight ?? 9;
    const totalH = (opts.items ?? []).reduce((acc, it) => acc + (it.separator ? sH : iH), 0);
    super({ width: opts.width ?? 220, height: totalH + 8, placement: 'auto', offset: 2 });
    this.id = `context-menu-${nextContextMenuId++}`;

    this._opts = opts;
    this._items = opts.items ?? [];
    this._font = opts.font ?? '13px sans-serif';
    this._textColor = opts.color ?? '#e2e8f0';
    this._disColor = opts.disabledColor ?? 'rgba(255,255,255,0.3)';
    this._bg = opts.bg ?? 'rgba(18,18,32,0.97)';
    this._hoverBg = opts.hoverBg ?? 'rgba(0,240,255,0.14)';
    this._border = opts.borderColor ?? 'rgba(255,255,255,0.12)';
    this._iH = iH;
    this._sH = sH;
    this.interactive = true;

    this.on('pointermove', (e: { localY?: number }) => {
      this._hoverIdx = e.localY === undefined ? -1 : this._idxAt(e.localY);
      this.scene?.markDirty();
    });
    this.on('pointerleave', () => {
      this._hoverIdx = -1;
      this.scene?.markDirty();
    });
    this.on('pointerdown', (e: { localY?: number }) => {
      if (e.localY === undefined) return;
      const idx = this._idxAt(e.localY);
      const item = this._items[idx];
      if (!item || item.separator || item.disabled) return;
      if (item.children && item.children.length > 0) {
        // Lazy-create the submenu, and rebuild it if a *different* item's
        // children are being opened — reusing `_submenu` across items would
        // just reposition whichever item's submenu happened to be built
        // first, never reflecting the newly-clicked item's own children.
        if (!this._submenu || this._submenuFor !== item) {
          if (this._submenu) this._submenu.destroy();
          this._submenu = new ContextMenu({ ...this._opts, items: item.children });
          this._submenu._parentMenu = this;
          this._submenuFor = item;
          if (this.scene) this.scene.overlayRoot.add(this._submenu);
        }
        this._submenu.showAtPoint(this.x + this.width, this.y + this._rowTop(idx));
      } else {
        item.onClick?.();
        this._rootMenu().hide();
      }
    });
  }

  public override showAtPoint(x: number, y: number, source?: Entity | Scene): void {
    // Resolve the scene the same way the base Overlay.showAtPoint does (see
    // its `source` doc) — this override previously checked `this.scene`
    // directly and dropped `source` entirely when calling `super`, so a
    // freshly-constructed ContextMenu's FIRST showAtPoint call skipped the
    // backdrop setup (this.scene was null) and passed no source down to the
    // base implementation either — a silent no-op on top of a silent no-op.
    const scene: Scene | null = (this.scene as Scene | null) ?? this._sceneFromSource(source);
    if (this._parentMenu === null && !this._backdrop && scene) {
      const backdrop = new (class ContextMenuBackdrop extends Entity {
        isPointInside(): boolean {
          return true;
        }
        render(): void {
          // Invisible — exists only to intercept the outside click.
        }
      })('context-menu-backdrop');
      backdrop.width = scene.width;
      backdrop.height = scene.height;
      backdrop.interactive = true;
      backdrop.on('click', (e: VectoJSEvent) => {
        e.stopPropagation();
        this.hide();
      });
      // Hit-testing checks the most-recently-added child first (the one
      // visually on top), and the backdrop's isPointInside() always returns
      // true — so it must be added *before* the menu, never after, or it
      // would swallow clicks meant for the menu's own items. The menu is
      // typically already mounted (consumers call `scene.add(menu)` once up
      // front, per the class-level usage example), so re-parenting it after
      // the backdrop is the only way to get that order using the public
      // add()/remove() API instead of reaching into the children array.
      const parent = this.parent ?? scene.overlayRoot;
      if (this.parent) this.parent.remove(this);
      scene.overlayRoot.add(backdrop);
      parent.add(this);
      this._backdrop = backdrop;
    }
    super.showAtPoint(x, y, source);
  }

  public override hide(): void {
    if (this._backdrop) {
      this._backdrop.destroy();
      this._backdrop = null;
    }
    if (this._submenu) this._submenu.hide();
    super.hide();
  }

  public override destroy(): void {
    if (this._backdrop) {
      this._backdrop.destroy();
      this._backdrop = null;
    }
    if (this._submenu) {
      this._submenu.destroy();
      this._submenu = null;
    }
    this._parentMenu = null;
    super.destroy();
  }

  private _rootMenu(): ContextMenu {
    return this._parentMenu?._rootMenu() ?? this;
  }

  private _idxAt(localY: number): number {
    let y = 4;
    for (let i = 0; i < this._items.length; i++) {
      const h = this._items[i].separator ? this._sH : this._iH;
      if (localY >= y && localY < y + h) return i;
      y += h;
    }
    return -1;
  }

  private _rowTop(idx: number): number {
    let y = 4;
    for (let i = 0; i < idx; i++) y += this._items[i].separator ? this._sH : this._iH;
    return y;
  }

  public render(r: IRenderer): void {
    // Background + border
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, 8);
    r.fill(this._bg);
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, 8);
    r.stroke(this._border, 1);

    let y = 4;
    for (let i = 0; i < this._items.length; i++) {
      const item = this._items[i];

      if (item.separator) {
        const mid = y + this._sH / 2;
        r.beginPath();
        r.moveTo(8, mid);
        r.lineTo(this.width - 8, mid);
        r.stroke('rgba(255,255,255,0.1)', 1);
        y += this._sH;
        continue;
      }

      const col = item.disabled ? this._disColor : this._textColor;

      // Hover highlight
      if (i === this._hoverIdx && !item.disabled) {
        r.beginPath();
        r.roundRect(4, y, this.width - 8, this._iH, 4);
        r.fill(this._hoverBg);
      }

      const ty = y + this._iH / 2 + 4;
      let lx = 12;

      // Icon
      if (item.icon) {
        r.fillText(item.icon, lx, ty, this._font, col);
        lx += 22;
      }

      // Label
      r.fillText(item.label ?? '', lx, ty, this._font, col);

      // Shortcut (right-aligned). fillText's x/y is the text's left/baseline
      // origin, not an anchor IRenderer right-aligns for you — drawing at
      // `this.width - 12` unconditionally made the hint start there and run
      // rightward, overflowing past the menu's own border for anything wider
      // than a couple of characters (e.g. "Ctrl+C"). Subtract the measured
      // width so the text's *right* edge lands at that inset instead.
      if (item.shortcut) {
        r.fillText(
          item.shortcut,
          this.width - 12 - measureText(item.shortcut, this._font),
          ty,
          this._font,
          item.disabled ? this._disColor : 'rgba(255,255,255,0.4)',
        );
      }

      // Submenu indicator
      if (item.children && item.children.length > 0) {
        r.fillText('▸', this.width - 16, ty, '10px sans-serif', 'rgba(255,255,255,0.5)');
      }

      y += this._iH;
    }
  }

  public getA11yAttributes(): A11yAttributes {
    return { role: 'menu', label: 'Context menu' };
  }
}
