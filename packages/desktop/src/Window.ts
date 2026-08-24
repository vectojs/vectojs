import { type A11yAttributes, Entity, type IRenderer, type Scene } from '@vectojs/core';
import { Button, Card, Text, UIComponent } from '@vectojs/ui';
import type { AppContext, AppDefinition } from './types';
import type { Vfs } from './Vfs';
import type { WindowManager } from './WindowManager';
import { addButtonIcon, WINDOW_ICONS } from './icon';

export interface WindowChrome {
  windowBg: string;
  windowBorder: string;
  titlebarBg: string;
  titlebarFg: string;
  titlebarHeight: number;
  closeBg: string;
  closeFg: string;
  focusRing: string;
  radius: number;
  resizeHandle: number;
  minWidth: number;
  minHeight: number;
}

export interface WindowOptions {
  app: AppDefinition;
  windowId: string;
  title?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  chrome: WindowChrome;
  scene: Scene;
  vfs: Vfs | null;
  windowManager: WindowManager;
  /** Work-area clamp (display minus taskbar). */
  workArea: () => { x: number; y: number; width: number; height: number };
  onClose: (win: DesktopWindow) => void;
  onFocus: (win: DesktopWindow) => void;
  onStateChange?: (win: DesktopWindow) => void;
  /**
   * Shell-dialog chrome (set by {@link WindowManager.openDialog}): close-only
   * titlebar, no resize/maximize/minimize affordances, and `ariaModal`
   * projection when `modal` is true. Absent for regular app windows.
   */
  dialog?: {
    /** Modal dialogs hold focus while open (refocus of other windows blocked). */
    modal?: boolean;
    /** Escape closes the dialog. Default true. */
    dismissible?: boolean;
  };
}

/** Default outer window size when neither the app nor the opener specifies one. */
export const DEFAULT_WINDOW_WIDTH = 480;
export const DEFAULT_WINDOW_HEIGHT = 340;

type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** Subset of VectoJSEvent pointer fields used by window chrome. */
interface PointerCoords {
  localX?: number;
  localY?: number;
  sceneX?: number;
  sceneY?: number;
  clientX?: number;
  clientY?: number;
  target?: Entity;
  stopPropagation?: () => void;
}

/** Subset of VectoJSEvent keyboard fields used by the titlebar drag handle. */
interface KeyboardMoveEvent {
  key?: string;
  shiftKey?: boolean;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

class ClientHost extends Entity {
  public override isPointInside(): boolean {
    return false;
  }
  public override render(_r: IRenderer): void {}
}

/**
 * Corner grip marks drawn while a window is focused and restorable so the
 * edge/corner resize targets (a 6px rim on the window root) are discoverable.
 */
class ResizeGrips extends Entity {
  constructor(
    private readonly visible: () => boolean,
    private readonly color: () => string,
  ) {
    super();
    this.interactive = false;
    this.a11yProjection = 'never';
  }

  public override isPointInside(): boolean {
    return false;
  }

  public override render(r: IRenderer): void {
    if (!this.visible()) return;
    const g = 6;
    const len = 12;
    const w = this.width;
    const h = this.height;
    const color = this.color();
    const corners = [
      { x: g, y: g, sx: -1, sy: -1 },
      { x: w - g, y: g, sx: 1, sy: -1 },
      { x: g, y: h - g, sx: -1, sy: 1 },
      { x: w - g, y: h - g, sx: 1, sy: 1 },
    ];
    for (const c of corners) {
      r.beginPath();
      r.moveTo(c.x + c.sx * len, c.y);
      r.lineTo(c.x, c.y);
      r.lineTo(c.x, c.y + c.sy * len);
      r.stroke(color, 1.5);
    }
  }
}

/**
 * Invisible titlebar drag surface. Must be its own interactive entity so the
 * window root can stay `pointerEvents: 'none'` (otherwise the dialog a11y
 * mirror covers the whole window, shows a pointer cursor everywhere, and
 * steals clicks from chrome buttons and client content).
 */
class TitlebarDragHandle extends UIComponent {
  public override getA11yAttributes(): A11yAttributes {
    return {
      role: 'button',
      label: 'Move window',
      tabIndex: 0,
    };
  }
  public override render(_r: IRenderer): void {}
}

interface RestoredGeom {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One desktop window — KWin/Aero-style chrome:
 * titlebar drag, min / max / close, edge+corner resize, maximize toggle.
 *
 * Defaults to `a11yProjection: 'onDemand'`. The frame Card is non-interactive
 * so it never steals titlebar or client hits.
 */
export class DesktopWindow extends UIComponent {
  public readonly appId: string;
  public readonly windowId: string;
  public readonly title: string;
  public readonly appIconSvg: string | undefined;
  public readonly chrome: WindowChrome;
  /** True when opened as a shell dialog (close-only chrome, no resize). */
  public readonly isDialog: boolean;
  /** Modal dialogs hold focus while open (enforced by the window manager). */
  public readonly modal: boolean;
  /** Escape closes this dialog (shell-dialog option, default true). */
  public readonly dismissible: boolean;
  public focused = false;
  public maximized = false;
  public minimized = false;

  private readonly shell: Card;
  private readonly titlebar: Card;
  private readonly titleLabel: Text;
  private readonly minBtn: Button | null;
  private readonly maxBtn: Button | null;
  private readonly closeBtn: Button;
  private readonly dragHandle: TitlebarDragHandle;
  private readonly grips: ResizeGrips;
  private readonly clientHost: Entity;
  private readonly content: Entity;
  private readonly onClose: (win: DesktopWindow) => void;
  private readonly onFocus: (win: DesktopWindow) => void;
  private readonly onStateChange?: (win: DesktopWindow) => void;
  private readonly workArea: () => {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  private readonly appMinWidth: number;
  private readonly appMinHeight: number;

  private dragging = false;
  private dragOffsetX = 0;
  private dragOffsetY = 0;
  private resizing: ResizeEdge | null = null;
  private resizeStart = { x: 0, y: 0, w: 0, h: 0, px: 0, py: 0 };
  private restored: RestoredGeom | null = null;

  private readonly onDocPointerMove: (e: PointerEvent) => void;
  private readonly onDocPointerUp: (e: PointerEvent) => void;

  constructor(opts: WindowOptions) {
    super();
    this.appId = opts.app.id;
    this.windowId = opts.windowId;
    this.title = opts.title ?? opts.app.title;
    this.appIconSvg = opts.app.iconSvg;
    this.chrome = opts.chrome;
    this.isDialog = opts.dialog !== undefined;
    this.modal = opts.dialog?.modal ?? false;
    this.dismissible = opts.dialog?.dismissible ?? true;
    this.onClose = opts.onClose;
    this.onFocus = opts.onFocus;
    this.onStateChange = opts.onStateChange;
    this.workArea = opts.workArea;
    this.appMinWidth = opts.app.minWidth ?? 0;
    this.appMinHeight = opts.app.minHeight ?? 0;

    this.width = Math.max(this.minWidth(), opts.width ?? DEFAULT_WINDOW_WIDTH);
    this.height = Math.max(this.minHeight(), opts.height ?? DEFAULT_WINDOW_HEIGHT);
    this.x = opts.x ?? 48;
    this.y = opts.y ?? 48;
    this.interactive = true;
    this.a11yProjection = 'onDemand';

    const th = this.chrome.titlebarHeight;
    const btnW = 28;
    const btnH = 24;
    const btnY = Math.max(4, (th - btnH) / 2);
    const btnGap = 4;

    // Frame only — never set `label` (labeled Cards become interactive and
    // steal the whole window's hit target).
    this.shell = new Card({
      width: this.width,
      height: this.height,
      bg: this.chrome.windowBg,
      border: this.chrome.windowBorder,
      radius: this.chrome.radius,
    });
    this.shell.interactive = false;
    this.shell.a11yProjection = 'never';
    this.shell.getA11yAttributes = () => ({ pointerEvents: 'none' });
    this.add(this.shell);

    // Visual titlebar strip; drag is handled on DesktopWindow so localX/Y
    // stay in window coordinates.
    this.titlebar = new Card({
      width: this.width,
      height: th,
      bg: this.chrome.titlebarBg,
      radius: 0,
      borderWidth: 0,
    });
    this.titlebar.a11yProjection = 'never';
    this.titlebar.interactive = false;
    this.titlebar.getA11yAttributes = () => ({ pointerEvents: 'none' });
    this.shell.add(this.titlebar);

    this.titleLabel = new Text(this.title, {
      font: '600 13px "Segoe UI",system-ui,sans-serif',
      color: this.chrome.titlebarFg,
      selectable: false,
    });
    this.titleLabel.x = 12;
    this.titleLabel.y = Math.max(0, (th - 16) / 2);
    this.titleLabel.interactive = false;
    this.titleLabel.a11yProjection = 'never';
    this.shell.add(this.titleLabel);

    // Drag surface: titlebar minus chrome buttons. Interactive + eager a11y so
    // the move hit target is always present without pinning the whole dialog.
    this.dragHandle = new TitlebarDragHandle();
    this.dragHandle.x = 0;
    this.dragHandle.y = 0;
    this.dragHandle.width = Math.max(0, this.width - this.chromeBtnStripWidth());
    this.dragHandle.height = th;
    this.dragHandle.interactive = true;
    this.dragHandle.a11yProjection = 'eager';
    this.dragHandle.on('pointerdown', (e: unknown) => this.beginTitlebarDrag(e as PointerCoords));
    if (!this.isDialog) {
      // Shell dialogs cannot maximize: no dblclick toggle on the titlebar.
      this.dragHandle.on('dblclick', () => this.toggleMaximize());
    }
    this.dragHandle.on('keydown', (e: unknown) => this.handleMoveKey(e as KeyboardMoveEvent));
    this.shell.add(this.dragHandle);

    this.closeBtn = this.makeChromeBtn(WINDOW_ICONS.close, 'Close', () => this.onClose(this), true);
    this.maxBtn = this.isDialog
      ? null
      : this.makeChromeBtn(WINDOW_ICONS.maximize, 'Maximize', () => this.toggleMaximize(), false);
    this.minBtn = this.isDialog
      ? null
      : this.makeChromeBtn(WINDOW_ICONS.minimize, 'Minimize', () => this.minimize(), false);

    this.closeBtn.x = this.width - btnW - 8;
    this.closeBtn.y = btnY;
    if (this.maxBtn) {
      this.maxBtn.x = this.closeBtn.x - btnW - btnGap;
      this.maxBtn.y = btnY;
    }
    if (this.minBtn) {
      this.minBtn.x = (this.maxBtn?.x ?? this.closeBtn.x) - btnW - btnGap;
      this.minBtn.y = btnY;
    }
    if (this.minBtn) this.shell.add(this.minBtn);
    if (this.maxBtn) this.shell.add(this.maxBtn);
    this.shell.add(this.closeBtn);

    this.grips = new ResizeGrips(
      () => this.focused && !this.maximized && !this.minimized && !this.isDialog,
      () => this.chrome.focusRing,
    );
    this.grips.a11yProjection = 'never';
    this.shell.add(this.grips);
    this.sizeGrips();

    this.clientHost = new ClientHost();
    this.clientHost.x = 0;
    this.clientHost.y = th;
    this.clientHost.width = this.width;
    this.clientHost.height = Math.max(0, this.height - th);
    this.clientHost.clipChildren = true;
    this.clientHost.interactive = false;
    this.clientHost.a11yProjection = 'never';
    this.shell.add(this.clientHost);

    const ctx: AppContext = {
      scene: opts.scene,
      appId: opts.app.id,
      windowId: opts.windowId,
      vfs: opts.vfs,
      windowManager: opts.windowManager,
      close: () => this.onClose(this),
    };
    this.content = opts.app.create(ctx);
    this.clientHost.add(this.content);
    this.layoutClientContent();

    // Resize edges still start from the window when a press lands on an edge
    // handle region of the drag surface / frame. Edge hits use the drag handle
    // plus a thin resize rim on the window via dedicated listeners below.
    this.on('pointerdown', (e: unknown) => this.handleResizePointerDown(e as PointerCoords));

    this.onDocPointerMove = (e) => this.handleDocPointerMove(e);
    this.onDocPointerUp = () => this.handleDocPointerUp();
  }

  private scenePointFromClient(clientX: number, clientY: number): { x: number; y: number } {
    const scene = this.scene;
    if (scene && typeof scene.clientToScene === 'function') {
      return scene.clientToScene(clientX, clientY);
    }
    return { x: clientX, y: clientY };
  }

  private makeChromeBtn(
    iconSvg: string,
    aria: string,
    onClick: () => void,
    danger: boolean,
  ): Button {
    const bg = danger ? this.chrome.closeBg : this.chrome.titlebarBg;
    const fg = danger ? this.chrome.closeFg : this.chrome.titlebarFg;
    const b = new Button('', {
      bg,
      hoverBg: danger ? '#e04343' : this.chrome.windowBorder,
      color: fg,
      font: '600 14px "Segoe UI",system-ui,sans-serif',
      padding: 4,
      radius: 3,
      width: 28,
      height: 24,
      onClick,
    });
    addButtonIcon(b, iconSvg, 14, fg);
    // Eager: onDemand only materializes under the pointer on the *next* a11y
    // sync, so the first click on a chrome button would miss. Always project.
    b.a11yProjection = 'eager';
    const orig = b.getA11yAttributes.bind(b);
    b.getA11yAttributes = () => ({ ...orig(), label: aria });
    b.on('pointerdown', (ev: PointerCoords) => {
      ev.stopPropagation?.();
    });
    return b;
  }

  public override getA11yAttributes(): A11yAttributes {
    // pointerEvents:none — the dialog mirror is for AT structure only. A full-
    // window auto mirror sits above children, forces cursor:pointer everywhere,
    // and eats clicks meant for chrome buttons and client controls.
    return {
      role: 'dialog',
      label: this.title,
      ariaModal: this.modal ? 'true' : 'false',
      pointerEvents: 'none',
    };
  }

  public setFocused(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    this.shell.border = focused ? this.chrome.focusRing : this.chrome.windowBorder;
    this.scene?.markDirty();
  }

  public updateChrome(chrome: WindowChrome): void {
    Object.assign(this.chrome, chrome);
    // Read the MERGED state, not the argument: a partial argument (allowed by
    // the type only in spirit — both current call sites pass full resolveChrome
    // objects) would otherwise clobber shell bg/border/radius and titlebar
    // colors with undefined.
    this.shell.bg = this.chrome.windowBg;
    this.shell.border = this.focused ? this.chrome.focusRing : this.chrome.windowBorder;
    this.shell.radius = this.chrome.radius;
    this.titlebar.bg = this.chrome.titlebarBg;
    this.titleLabel.color = this.chrome.titlebarFg;
    this.scene?.markDirty();
  }

  public get client(): Entity {
    return this.clientHost;
  }

  public get clientContent(): Entity {
    return this.content;
  }

  public maximize(): void {
    if (this.maximized) {
      const area = this.workArea();
      this.applyGeom(area.x, area.y, area.width, area.height);
      return;
    }
    if (this.minimized) this.restoreFromMinimized();
    this.restored = {
      x: this.x,
      y: this.y,
      width: this.width,
      height: this.height,
    };
    const area = this.workArea();
    this.applyGeom(area.x, area.y, area.width, area.height);
    this.maximized = true;
    this.maxBtn?.setLabel('❐');
    this.notifyState();
  }

  public restore(): void {
    if (!this.maximized || !this.restored) return;
    const r = this.restored;
    this.restored = null;
    this.maximized = false;
    this.applyGeom(r.x, r.y, r.width, r.height);
    this.maxBtn?.setLabel('□');
    this.notifyState();
  }

  public toggleMaximize(): void {
    if (this.maximized) this.restore();
    else this.maximize();
  }

  public minimize(): void {
    if (this.minimized) return;
    this.minimized = true;
    this.opacity = 0;
    this.interactive = false;
    this.a11yHidden = true;
    this.scene?.markDirty();
    this.notifyState();
  }

  public restoreFromMinimized(): void {
    if (!this.minimized) return;
    this.minimized = false;
    this.opacity = 1;
    this.interactive = true;
    this.a11yHidden = false;
    this.scene?.markDirty();
    this.notifyState();
  }

  public setGeometry(x: number, y: number, w: number, h: number): void {
    if (this.maximized) {
      this.restored = null;
      this.maximized = false;
      this.maxBtn?.setLabel('□');
    }
    this.applyGeom(x, y, w, h);
  }

  /** Effective min width: the app's floor layered over the theme's global floor. */
  private minWidth(): number {
    return Math.max(this.chrome.minWidth, this.appMinWidth);
  }

  /** Effective min height: the app's floor layered over the theme's global floor. */
  private minHeight(): number {
    return Math.max(this.chrome.minHeight, this.appMinHeight);
  }

  private applyGeom(x: number, y: number, w: number, h: number): void {
    const minW = this.minWidth();
    const minH = this.minHeight();
    this.x = x;
    this.y = y;
    this.width = Math.max(minW, w);
    this.height = Math.max(minH, h);
    this.shell.width = this.width;
    this.shell.height = this.height;
    this.titlebar.width = this.width;
    this.clientHost.width = this.width;
    this.clientHost.height = Math.max(0, this.height - this.chrome.titlebarHeight);

    const btnW = 28;
    const btnGap = 4;
    this.closeBtn.x = this.width - btnW - 8;
    if (this.maxBtn) this.maxBtn.x = this.closeBtn.x - btnW - btnGap;
    if (this.minBtn) this.minBtn.x = (this.maxBtn?.x ?? this.closeBtn.x) - btnW - btnGap;
    this.dragHandle.width = Math.max(0, this.width - this.chromeBtnStripWidth());
    this.dragHandle.height = this.chrome.titlebarHeight;
    this.sizeGrips();
    this.layoutClientContent();
    this.scene?.markDirty();
  }

  private sizeGrips(): void {
    this.grips.width = this.width;
    this.grips.height = this.height;
  }

  /** Stretch the app root to the client host box when it exposes width/height. */
  private layoutClientContent(): void {
    const c = this.content as Entity & { width?: number; height?: number };
    if (typeof c.width === 'number') c.width = this.clientHost.width;
    if (typeof c.height === 'number') c.height = this.clientHost.height;
  }

  private notifyState(): void {
    this.onStateChange?.(this);
  }

  private chromeBtnStripWidth(): number {
    // Dialogs carry a single Close button in the strip.
    return this.isDialog ? 8 + 28 + 4 : 8 + 28 * 3 + 4 * 2 + 4;
  }

  private hitResizeEdge(lx: number, ly: number): ResizeEdge | null {
    if (this.maximized || this.isDialog) return null;
    const h = this.chrome.resizeHandle;
    const nearL = lx <= h;
    const nearR = lx >= this.width - h;
    const nearT = ly <= h;
    const nearB = ly >= this.height - h;
    if (nearT && nearL) return 'nw';
    if (nearT && nearR) return 'ne';
    if (nearB && nearL) return 'sw';
    if (nearB && nearR) return 'se';
    if (nearT) return 'n';
    if (nearB) return 's';
    if (nearL) return 'w';
    if (nearR) return 'e';
    return null;
  }

  private isChromeButton(node: Entity): boolean {
    for (let n: Entity | null = node; n; n = n.parent) {
      if (n === this.closeBtn || n === this.maxBtn || n === this.minBtn) {
        return true;
      }
      if (n === this) return false;
    }
    return false;
  }

  private scenePtOf(e: PointerCoords): { x: number; y: number } {
    if (e.sceneX !== undefined && e.sceneY !== undefined) {
      return { x: e.sceneX, y: e.sceneY };
    }
    return this.scenePointFromClient(e.clientX ?? 0, e.clientY ?? 0);
  }

  /** Titlebar drag — fired on the dedicated drag-handle entity. */
  private beginTitlebarDrag(e: PointerCoords): void {
    this.onFocus(this);
    if (this.minimized) return;
    // local coords are relative to the drag handle (origin = titlebar left).
    const lx = e.localX ?? 0;
    if (this.maximized) {
      const ratio = lx / Math.max(1, this.dragHandle.width);
      this.restore();
      const scenePt = this.scenePtOf(e);
      this.x = scenePt.x - this.width * ratio;
      this.y = scenePt.y - this.chrome.titlebarHeight / 2;
    }
    this.dragging = true;
    const scenePt = this.scenePtOf(e);
    this.dragOffsetX = scenePt.x - this.x;
    this.dragOffsetY = scenePt.y - this.y;
    this.attachDocPointers();
  }

  /**
   * Edge resize from presses that hit the window root. Children own their
   * points first — the titlebar handle and chrome buttons absorb their own
   * hits, and `ClientHost.isPointInside()` is false so client-area presses
   * fall through to the root — so only the 6px rim around the frame lands
   * here. `maximized` windows have no rim (hitResizeEdge returns null).
   */
  private handleResizePointerDown(e: PointerCoords): void {
    this.onFocus(this);
    if (this.minimized) return;
    const t = e.target;
    if (t && this.isChromeButton(t)) return;
    if (t === this.dragHandle) return;
    const lx = e.localX ?? 0;
    const ly = e.localY ?? 0;
    const edge = this.hitResizeEdge(lx, ly);
    if (!edge) return;
    this.resizing = edge;
    const scenePt = this.scenePtOf(e);
    this.resizeStart = {
      x: this.x,
      y: this.y,
      w: this.width,
      h: this.height,
      px: scenePt.x,
      py: scenePt.y,
    };
    this.attachDocPointers();
  }

  private attachDocPointers(): void {
    window.addEventListener('pointermove', this.onDocPointerMove);
    window.addEventListener('pointerup', this.onDocPointerUp);
    window.addEventListener('pointercancel', this.onDocPointerUp);
  }

  private detachDocPointers(): void {
    window.removeEventListener('pointermove', this.onDocPointerMove);
    window.removeEventListener('pointerup', this.onDocPointerUp);
    window.removeEventListener('pointercancel', this.onDocPointerUp);
  }

  private handleDocPointerMove(e: PointerEvent): void {
    const scenePt = this.scenePointFromClient(e.clientX, e.clientY);
    if (this.resizing) {
      this.applyResize(scenePt.x, scenePt.y);
      return;
    }
    if (!this.dragging) return;
    const { x, y } = this.clampMovePosition(
      scenePt.x - this.dragOffsetX,
      scenePt.y - this.dragOffsetY,
    );
    this.x = x;
    this.y = y;
    this.scene?.markDirty();
  }

  /**
   * Keyboard move — the titlebar drag handle is tabbable (tabIndex 0), so an
   * AT or power user can arrow the window around (Shift = 1px fine move).
   */
  private handleMoveKey(e: KeyboardMoveEvent): void {
    const step = e.shiftKey ? 1 : 16;
    let dx = 0;
    let dy = 0;
    switch (e.key) {
      case 'ArrowLeft':
        dx = -step;
        break;
      case 'ArrowRight':
        dx = step;
        break;
      case 'ArrowUp':
        dy = -step;
        break;
      case 'ArrowDown':
        dy = step;
        break;
      default:
        return;
    }
    e.preventDefault?.();
    e.stopPropagation?.();
    if (this.maximized || this.minimized) return;
    const { x, y } = this.clampMovePosition(this.x + dx, this.y + dy);
    this.x = x;
    this.y = y;
    this.scene?.markDirty();
  }

  /** Clamp a move so the titlebar (and 48px of frame) stays inside the work area. */
  private clampMovePosition(nx: number, ny: number): { x: number; y: number } {
    const area = this.workArea();
    nx = Math.min(Math.max(nx, area.x - this.width + 48), area.x + area.width - 48);
    ny = Math.min(Math.max(ny, area.y), area.y + area.height - this.chrome.titlebarHeight);
    return { x: nx, y: ny };
  }

  private applyResize(sceneX: number, sceneY: number): void {
    if (!this.resizing) return;
    const dx = sceneX - this.resizeStart.px;
    const dy = sceneY - this.resizeStart.py;
    const minW = this.minWidth();
    const minH = this.minHeight();
    let { x, y, w, h } = {
      x: this.resizeStart.x,
      y: this.resizeStart.y,
      w: this.resizeStart.w,
      h: this.resizeStart.h,
    };
    const edge = this.resizing;
    if (edge.includes('e')) w = Math.max(minW, this.resizeStart.w + dx);
    if (edge.includes('s')) h = Math.max(minH, this.resizeStart.h + dy);
    if (edge.includes('w')) {
      const nw = Math.max(minW, this.resizeStart.w - dx);
      x = this.resizeStart.x + (this.resizeStart.w - nw);
      w = nw;
    }
    if (edge.includes('n')) {
      const nh = Math.max(minH, this.resizeStart.h - dy);
      y = this.resizeStart.y + (this.resizeStart.h - nh);
      h = nh;
    }
    const area = this.workArea();
    if (x < area.x) {
      w -= area.x - x;
      x = area.x;
    }
    if (y < area.y) {
      h -= area.y - y;
      y = area.y;
    }
    if (x + w > area.x + area.width) w = area.x + area.width - x;
    if (y + h > area.y + area.height) h = area.y + area.height - y;
    this.applyGeom(x, y, Math.max(minW, w), Math.max(minH, h));
  }

  private handleDocPointerUp(): void {
    if (this.dragging || this.resizing) {
      this.dragging = false;
      this.resizing = null;
      this.detachDocPointers();
    }
  }

  public override destroy(): void {
    this.detachDocPointers();
    super.destroy();
  }

  public override render(_r: IRenderer): void {}
}
