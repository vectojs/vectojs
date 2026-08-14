import { type A11yAttributes, Entity, type IRenderer, type Scene } from '@vectojs/core';
import { Button, Card, Text, UIComponent } from '@vectojs/ui';
import type { AppDefinition } from './types';

export interface WindowOptions {
  app: AppDefinition;
  title?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  /** Theme-resolved chrome colours (already concrete, not var()). */
  chrome: WindowChrome;
  onClose: (win: DesktopWindow) => void;
  onFocus: (win: DesktopWindow) => void;
}

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
}

const DEFAULT_W = 420;
const DEFAULT_H = 300;

/** Concrete clip host for window client content (Entity is abstract). */
class ClientHost extends Entity {
  public override isPointInside(): boolean {
    return false;
  }
  public override render(_r: IRenderer): void {}
}

/**
 * One desktop window: titlebar + client host.
 *
 * Defaults to {@link Entity.a11yProjection} `'onDemand'` so background windows
 * carry zero a11y projection until focused, pointed at, or explicitly requested.
 */
export class DesktopWindow extends UIComponent {
  public readonly appId: string;
  public readonly title: string;
  public readonly chrome: WindowChrome;
  public focused = false;

  private readonly shell: Card;
  private readonly titleLabel: Text;
  private readonly closeBtn: Button;
  private readonly clientHost: Entity;
  private readonly content: Entity;
  private readonly onClose: (win: DesktopWindow) => void;
  private readonly onFocus: (win: DesktopWindow) => void;

  private dragging = false;
  private dragOffsetX = 0;
  private dragOffsetY = 0;
  private readonly onPointerMove: (e: PointerEvent) => void;
  private readonly onPointerUp: (e: PointerEvent) => void;

  constructor(opts: WindowOptions) {
    super();
    this.appId = opts.app.id;
    this.title = opts.title ?? opts.app.title;
    this.chrome = opts.chrome;
    this.onClose = opts.onClose;
    this.onFocus = opts.onFocus;

    this.width = opts.width ?? DEFAULT_W;
    this.height = opts.height ?? DEFAULT_H;
    this.x = opts.x ?? 48;
    this.y = opts.y ?? 48;
    this.interactive = true;
    this.a11yProjection = 'onDemand';

    const th = this.chrome.titlebarHeight;

    this.shell = new Card({
      width: this.width,
      height: this.height,
      bg: this.chrome.windowBg,
      border: this.chrome.windowBorder,
      radius: this.chrome.radius,
      label: this.title,
    });
    this.shell.a11yProjection = 'onDemand';
    this.add(this.shell);

    // Titlebar background strip (drawn by a child card so drag hit area is clear).
    const titlebar = new Card({
      width: this.width,
      height: th,
      bg: this.chrome.titlebarBg,
      radius: 0,
      borderWidth: 0,
    });
    titlebar.a11yProjection = 'never';
    titlebar.interactive = false;
    this.shell.add(titlebar);

    this.titleLabel = new Text(this.title, {
      font: '600 13px sans-serif',
      color: this.chrome.titlebarFg,
      selectable: false,
    });
    this.titleLabel.x = 12;
    this.titleLabel.y = Math.max(0, (th - 16) / 2);
    this.titleLabel.a11yProjection = 'onDemand';
    this.shell.add(this.titleLabel);

    this.closeBtn = new Button('×', {
      bg: this.chrome.closeBg,
      hoverBg: this.chrome.closeBg,
      color: this.chrome.closeFg,
      font: '600 14px sans-serif',
      padding: 4,
      radius: 6,
      width: 28,
      height: 24,
      onClick: () => this.onClose(this),
    });
    this.closeBtn.a11yProjection = 'onDemand';
    this.closeBtn.x = this.width - 36;
    this.closeBtn.y = Math.max(4, (th - 24) / 2);
    this.shell.add(this.closeBtn);

    this.clientHost = new ClientHost();
    this.clientHost.x = 0;
    this.clientHost.y = th;
    this.clientHost.width = this.width;
    this.clientHost.height = Math.max(0, this.height - th);
    this.clientHost.clipChildren = true;
    this.clientHost.a11yProjection = 'onDemand';
    this.shell.add(this.clientHost);

    this.content = opts.app.create({
      scene: null as unknown as Scene,
      appId: opts.app.id,
      close: () => this.onClose(this),
    });
    this.clientHost.add(this.content);

    this.on('pointerdown', (e: unknown) => this.handlePointerDown(e as PointerEvent));

    this.onPointerMove = (e: PointerEvent) => this.handlePointerMove(e);
    this.onPointerUp = (e: PointerEvent) => this.handlePointerUp(e);
  }

  /** Optional hook after the window is attached to a live scene. */
  public bindScene(_scene: Scene): void {}

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

  private titlebarHit(localX: number, localY: number): boolean {
    return (
      localY >= 0 && localY <= this.chrome.titlebarHeight && localX >= 0 && localX < this.width - 40
    );
  }

  private handlePointerDown(e: PointerEvent): void {
    this.onFocus(this);
    const localX = typeof e.offsetX === 'number' ? e.offsetX : 0;
    const localY = typeof e.offsetY === 'number' ? e.offsetY : 0;
    if (!this.titlebarHit(localX, localY)) return;
    this.dragging = true;
    this.dragOffsetX = (e.clientX ?? 0) - this.x;
    this.dragOffsetY = (e.clientY ?? 0) - this.y;
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
  }

  private handlePointerMove(e: PointerEvent): void {
    if (!this.dragging) return;
    this.x = (e.clientX ?? 0) - this.dragOffsetX;
    this.y = (e.clientY ?? 0) - this.dragOffsetY;
    this.scene?.markDirty();
  }

  private handlePointerUp(_e: PointerEvent): void {
    if (!this.dragging) return;
    this.dragging = false;
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
  }

  public override destroy(): void {
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    super.destroy();
  }

  public override render(_r: IRenderer): void {
    // Children paint themselves.
  }
}
