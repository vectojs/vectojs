import { type A11yAttributes, Entity, type IRenderer, type Scene } from '@vectojs/core';
import { Button, Card, Text, UIComponent } from '@vectojs/ui';
import type { AppContext, AppDefinition } from './types';
import type { Vfs } from './Vfs';

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
  /** Work-area clamp (display minus taskbar). */
  workArea: () => { x: number; y: number; width: number; height: number };
  onClose: (win: DesktopWindow) => void;
  onFocus: (win: DesktopWindow) => void;
  onStateChange?: (win: DesktopWindow) => void;
}

const DEFAULT_W = 480;
const DEFAULT_H = 340;

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

class ClientHost extends Entity {
  public override isPointInside(): boolean {
    return false;
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
  public readonly chrome: WindowChrome;
  public focused = false;
  public maximized = false;
  public minimized = false;

  private readonly shell: Card;
  private readonly titlebar: Card;
  private readonly titleLabel: Text;
  private readonly minBtn: Button;
  private readonly maxBtn: Button;
  private readonly closeBtn: Button;
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
    this.chrome = opts.chrome;
    this.onClose = opts.onClose;
    this.onFocus = opts.onFocus;
    this.onStateChange = opts.onStateChange;
    this.workArea = opts.workArea;

    this.width = opts.width ?? DEFAULT_W;
    this.height = opts.height ?? DEFAULT_H;
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

    this.closeBtn = this.makeChromeBtn('×', 'Close', () => this.onClose(this), true);
    this.maxBtn = this.makeChromeBtn('□', 'Maximize', () => this.toggleMaximize(), false);
    this.minBtn = this.makeChromeBtn('–', 'Minimize', () => this.minimize(), false);

    this.closeBtn.x = this.width - btnW - 8;
    this.closeBtn.y = btnY;
    this.maxBtn.x = this.closeBtn.x - btnW - btnGap;
    this.maxBtn.y = btnY;
    this.minBtn.x = this.maxBtn.x - btnW - btnGap;
    this.minBtn.y = btnY;
    this.shell.add(this.minBtn);
    this.shell.add(this.maxBtn);
    this.shell.add(this.closeBtn);

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
      close: () => this.onClose(this),
    };
    this.content = opts.app.create(ctx);
    this.clientHost.add(this.content);
    this.layoutClientContent();

    this.on('pointerdown', (e: unknown) => this.handlePointerDown(e as PointerCoords));
    this.on('dblclick', (e: unknown) => {
      const ev = e as PointerCoords;
      const localY = ev.localY ?? 0;
      if (localY <= this.chrome.titlebarHeight) this.toggleMaximize();
    });

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

  private makeChromeBtn(label: string, aria: string, onClick: () => void, danger: boolean): Button {
    const bg = danger ? this.chrome.closeBg : this.chrome.titlebarBg;
    const fg = danger ? this.chrome.closeFg : this.chrome.titlebarFg;
    const b = new Button(label, {
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
    b.a11yProjection = 'onDemand';
    const orig = b.getA11yAttributes.bind(b);
    b.getA11yAttributes = () => ({ ...orig(), label: aria });
    // Stop the window titlebar-drag handler from seeing this press.
    b.on('pointerdown', (ev: PointerCoords) => {
      ev.stopPropagation?.();
    });
    return b;
  }

  public override getA11yAttributes(): A11yAttributes {
    return {
      role: 'dialog',
      label: this.title,
      ariaModal: 'false',
    };
  }

  public setFocused(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    this.shell.border = focused ? this.chrome.focusRing : this.chrome.windowBorder;
    this.scene?.markDirty();
  }

  public get client(): Entity {
    return this.clientHost;
  }

  public get clientContent(): Entity {
    return this.content;
  }

  public maximize(): void {
    if (this.maximized) return;
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
    this.maxBtn.setLabel('❐');
    this.notifyState();
  }

  public restore(): void {
    if (!this.maximized || !this.restored) return;
    const r = this.restored;
    this.restored = null;
    this.maximized = false;
    this.applyGeom(r.x, r.y, r.width, r.height);
    this.maxBtn.setLabel('□');
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
      this.maxBtn.setLabel('□');
    }
    this.applyGeom(x, y, w, h);
  }

  private applyGeom(x: number, y: number, w: number, h: number): void {
    const minW = this.chrome.minWidth;
    const minH = this.chrome.minHeight;
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
    this.maxBtn.x = this.closeBtn.x - btnW - btnGap;
    this.minBtn.x = this.maxBtn.x - btnW - btnGap;
    this.layoutClientContent();
    this.scene?.markDirty();
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
    return 8 + 28 * 3 + 4 * 2 + 4;
  }

  private hitResizeEdge(lx: number, ly: number): ResizeEdge | null {
    if (this.maximized) return null;
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

  private titlebarDragHit(lx: number, ly: number): boolean {
    return (
      ly >= 0 &&
      ly <= this.chrome.titlebarHeight &&
      lx >= 0 &&
      lx < this.width - this.chromeBtnStripWidth()
    );
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

  private handlePointerDown(e: PointerCoords): void {
    this.onFocus(this);
    if (this.minimized) return;
    // Chrome buttons bubble pointerdown — do not start a drag.
    const t = e.target;
    if (t === this.closeBtn || t === this.maxBtn || t === this.minBtn) return;
    if (t && this.isChromeButton(t)) return;

    const lx = e.localX ?? 0;
    const ly = e.localY ?? 0;

    const edge = this.hitResizeEdge(lx, ly);
    if (edge) {
      this.resizing = edge;
      const scenePt =
        e.sceneX !== undefined && e.sceneY !== undefined
          ? { x: e.sceneX, y: e.sceneY }
          : this.scenePointFromClient(e.clientX ?? 0, e.clientY ?? 0);
      this.resizeStart = {
        x: this.x,
        y: this.y,
        w: this.width,
        h: this.height,
        px: scenePt.x,
        py: scenePt.y,
      };
      this.attachDocPointers();
      return;
    }

    if (this.titlebarDragHit(lx, ly)) {
      if (this.maximized) {
        const ratio = lx / Math.max(1, this.width);
        this.restore();
        const scenePt =
          e.sceneX !== undefined && e.sceneY !== undefined
            ? { x: e.sceneX, y: e.sceneY }
            : this.scenePointFromClient(e.clientX ?? 0, e.clientY ?? 0);
        this.x = scenePt.x - this.width * ratio;
        this.y = scenePt.y - this.chrome.titlebarHeight / 2;
      }
      this.dragging = true;
      const scenePt =
        e.sceneX !== undefined && e.sceneY !== undefined
          ? { x: e.sceneX, y: e.sceneY }
          : this.scenePointFromClient(e.clientX ?? 0, e.clientY ?? 0);
      this.dragOffsetX = scenePt.x - this.x;
      this.dragOffsetY = scenePt.y - this.y;
      this.attachDocPointers();
    }
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
    let nx = scenePt.x - this.dragOffsetX;
    let ny = scenePt.y - this.dragOffsetY;
    const area = this.workArea();
    nx = Math.min(Math.max(nx, area.x - this.width + 48), area.x + area.width - 48);
    ny = Math.min(Math.max(ny, area.y), area.y + area.height - this.chrome.titlebarHeight);
    this.x = nx;
    this.y = ny;
    this.scene?.markDirty();
  }

  private applyResize(sceneX: number, sceneY: number): void {
    if (!this.resizing) return;
    const dx = sceneX - this.resizeStart.px;
    const dy = sceneY - this.resizeStart.py;
    const minW = this.chrome.minWidth;
    const minH = this.chrome.minHeight;
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
