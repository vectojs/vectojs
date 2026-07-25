import { Entity, IRenderer, A11yAttributes, VectoJSEvent, type Scene } from '@vectojs/core';
import { Overlay } from './Overlay';
import { UIComponent } from './UIComponent';
import { measureText } from './measure';

let nextContextMenuId = 1;

/**
 * A transparent, focusable hotspot over one menu item so the a11y/automation
 * layer projects a real `role="menuitem"` (with a roving tabindex, `disabled`,
 * and `aria-haspopup`/`aria-expanded` for submenu parents) that a screen reader
 * and keyboard user can operate (WCAG 4.1.2 / 2.1.1). The {@link ContextMenu}
 * paints the row on canvas; this sits above it purely for semantics + focus.
 */
class MenuItemHotspot extends UIComponent {
  constructor(
    private menu: ContextMenu,
    public itemIndex: number,
  ) {
    super();
    this.interactive = true;
    this.on('click', () => this.menu.activateIndex(this.itemIndex));
    this.on('keydown', (e: KeyboardEvent) => this.menu.handleMenuKey(e, this.itemIndex));
  }
  public getA11yAttributes(): A11yAttributes {
    return this.menu.itemA11y(this.itemIndex);
  }
  public render(): void {
    /* invisible — ContextMenu paints the row */
  }
}

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
  /** One `role="menuitem"` hotspot per non-separator item (index into `_items`). */
  private _hotspots: MenuItemHotspot[] = [];
  /** Item index that owns the roving tab stop / keyboard focus. */
  private _activeIdx = -1;

  constructor(opts: ContextMenuOptions) {
    const iH = opts.itemHeight ?? 32;
    const sH = opts.separatorHeight ?? 9;
    const totalH = (opts.items ?? []).reduce((acc, it) => acc + (it.separator ? sH : iH), 0);
    super({
      width: opts.width ?? 220,
      height: totalH + 8,
      placement: 'auto',
      offset: 2,
    });
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
    // The menu starts hidden. Its semantic pointer surface is enabled only
    // while shown so a pre-mounted or previously hidden menu cannot remain an
    // invisible automation/input target at its last position.
    this.interactive = false;

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
          this._submenu = new ContextMenu({
            ...this._opts,
            items: item.children,
          });
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
    if (scene) this.interactive = true;
    if (this._parentMenu === null && !this._backdrop && scene) {
      const backdrop = new (class ContextMenuBackdrop extends Entity {
        isPointInside(): boolean {
          return true;
        }
        render(): void {
          // Invisible — exists only to intercept the outside click.
        }
      })(`${this.id}-backdrop`);
      backdrop.width = scene.width;
      backdrop.height = scene.height;
      backdrop.interactive = true;
      const dismiss = (e: VectoJSEvent): void => {
        e.stopPropagation();
        this.hide();
      };
      // Dismiss on pointerdown so the menu is closed before the browser can
      // retarget a later click after the semantic backdrop is detached. Keep
      // click as the keyboard/assistive-technology activation path.
      backdrop.on('pointerdown', dismiss);
      backdrop.on('click', dismiss);
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
    this._syncHotspots();
  }

  /**
   * Create/position one `role="menuitem"` hotspot per non-separator item, over
   * its row. Menus are small (not virtualized), so this rebuilds the pool to
   * match the item set. Called when the menu is shown.
   */
  private _syncHotspots(): void {
    const itemIdxs = this._items.map((it, i) => (it.separator ? -1 : i)).filter((i) => i >= 0);
    // Rebuild if the visible item set changed.
    if (this._hotspots.length !== itemIdxs.length) {
      for (const h of this._hotspots) {
        this.scene?.detachA11y?.(h);
        this.remove(h);
      }
      this._hotspots = itemIdxs.map((i) => new MenuItemHotspot(this, i));
      for (const h of this._hotspots) this.add(h);
    }
    for (let k = 0; k < itemIdxs.length; k++) {
      const i = itemIdxs[k];
      const h = this._hotspots[k];
      h.itemIndex = i;
      h.x = 4;
      h.y = this._rowTop(i);
      h.width = this.width - 8;
      h.height = this._iH;
    }
    // Default the roving tab stop to the first enabled item so a keyboard user
    // lands inside the menu.
    if (this._activeIdx < 0 || this._items[this._activeIdx]?.disabled) {
      this._activeIdx = this._firstEnabled();
    }
    this.scene?.markDirty();
  }

  private _firstEnabled(): number {
    return this._items.findIndex((it) => !it.separator && !it.disabled);
  }

  /** Whether item `idx` owns the roving tab stop (only one menuitem is a tab
   *  stop; arrows move within — WCAG menu pattern). */
  public isMenuTabStop(idx: number): boolean {
    const anchor = this._activeIdx >= 0 ? this._activeIdx : this._firstEnabled();
    return idx === anchor;
  }

  /** A11y attributes for one menu item (called by its hotspot). */
  public itemA11y(idx: number): A11yAttributes {
    const item = this._items[idx];
    const hasSub = !!(item?.children && item.children.length > 0);
    return {
      role: 'menuitem',
      label: item?.label ?? '',
      disabled: item?.disabled || undefined,
      haspopup: hasSub ? 'menu' : undefined,
      expanded: hasSub ? this._submenuFor === item && !!this._submenu : undefined,
      tabIndex: this.isMenuTabStop(idx) ? 0 : -1,
      // The ContextMenu owns mouse handling (pointerdown-by-localY selects the
      // row + opens submenus); this hotspot is for semantics + keyboard focus,
      // so it opts out of pointer hit-testing so a real click reaches the menu.
      // Keyboard focus and AT-synthesized `click` still work under this.
      pointerEvents: 'none',
    };
  }

  /** Activate an item by index (pointer click or Enter/Space): open a submenu,
   *  else fire onClick and close the menu tree. Mirrors the pointerdown path. */
  public activateIndex(idx: number): void {
    const item = this._items[idx];
    if (!item || item.separator || item.disabled) return;
    this._activeIdx = idx;
    if (item.children && item.children.length > 0) {
      this._openSubmenu(idx, item);
    } else {
      item.onClick?.();
      this._rootMenu().hide();
    }
  }

  /** Shared submenu open used by both the pointer and keyboard paths. */
  private _openSubmenu(idx: number, item: ContextMenuItem): void {
    if (!this._submenu || this._submenuFor !== item) {
      if (this._submenu) this._submenu.destroy();
      this._submenu = new ContextMenu({ ...this._opts, items: item.children! });
      this._submenu._parentMenu = this;
      this._submenuFor = item;
      if (this.scene) this.scene.overlayRoot.add(this._submenu);
    }
    this._submenu.showAtPoint(this.x + this.width, this.y + this._rowTop(idx));
    this._submenu._focusFirst();
  }

  /** Focus the first enabled item — used when a submenu opens via keyboard. */
  private _focusFirst(): void {
    const first = this._firstEnabled();
    if (first < 0) return;
    this._activeIdx = first;
    this._hotspots.find((h) => h.itemIndex === first)?.focus();
    this.scene?.markDirty();
  }

  /**
   * Menu keyboard model (WCAG menu pattern): Down/Up move to the next/previous
   * enabled item (wrapping, skipping separators + disabled); Home/End jump to
   * the first/last enabled item; Right opens a submenu parent; Left closes a
   * submenu back to its parent; Enter/Space activate; Escape closes the menu.
   */
  public handleMenuKey(e: KeyboardEvent, fromIdx: number): void {
    const keys = [
      'ArrowDown',
      'ArrowUp',
      'Home',
      'End',
      'ArrowRight',
      'ArrowLeft',
      'Enter',
      ' ',
      'Spacebar',
      'Escape',
      'Esc',
    ];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    switch (e.key) {
      case 'ArrowDown':
        this._focusItem(this._nextEnabled(fromIdx, 1));
        break;
      case 'ArrowUp':
        this._focusItem(this._nextEnabled(fromIdx, -1));
        break;
      case 'Home':
        this._focusItem(this._firstEnabled());
        break;
      case 'End':
        this._focusItem(this._lastEnabled());
        break;
      case 'ArrowRight': {
        const item = this._items[fromIdx];
        if (item?.children && item.children.length > 0) this._openSubmenu(fromIdx, item);
        break;
      }
      case 'ArrowLeft':
        if (this._parentMenu) {
          this.hide();
          this._parentMenu._refocusActive();
        }
        break;
      case 'Enter':
      case ' ':
      case 'Spacebar':
        this.activateIndex(fromIdx);
        break;
      case 'Escape':
      case 'Esc':
        this._rootMenu().hide();
        break;
    }
  }

  private _lastEnabled(): number {
    for (let i = this._items.length - 1; i >= 0; i--) {
      if (!this._items[i].separator && !this._items[i].disabled) return i;
    }
    return -1;
  }

  /** Next enabled, non-separator item index in `dir` (+1/-1), wrapping. */
  private _nextEnabled(from: number, dir: 1 | -1): number {
    const n = this._items.length;
    if (n === 0) return -1;
    for (let step = 1; step <= n; step++) {
      const idx = (from + dir * step + n * step) % n;
      const it = this._items[idx];
      if (!it.separator && !it.disabled) return idx;
    }
    return from;
  }

  private _focusItem(idx: number): void {
    if (idx < 0) return;
    this._activeIdx = idx;
    this._hotspots.find((h) => h.itemIndex === idx)?.focus();
    this.scene?.markDirty();
  }

  private _refocusActive(): void {
    const idx = this._activeIdx >= 0 ? this._activeIdx : this._firstEnabled();
    this._focusItem(idx);
  }

  public override hide(): void {
    const scene = this.scene;
    if (this._backdrop) {
      this._backdrop.destroy();
      this._backdrop = null;
    }
    if (this._submenu) this._submenu.hide();
    super.hide();
    this.interactive = false;
    for (const h of this._hotspots) scene?.detachA11y?.(h);
    scene?.detachA11y(this);
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
