import { type A11yAttributes, Entity, type IRenderer, type Scene } from '@vectojs/core';
import { Button, Card, UIComponent } from '@vectojs/ui';
import type { AppRegistry } from './AppRegistry';
import type { DesktopWindow } from './Window';
import type { WindowManager } from './WindowManager';

export interface TaskbarChrome {
  bg: string;
  fg: string;
  hover: string;
  active: string;
  height: number;
  position: 'bottom' | 'top';
}

export interface TaskbarOptions {
  scene: Scene;
  registry: AppRegistry;
  windowManager: WindowManager;
  chrome: TaskbarChrome;
  onToggleStart: () => void;
  width: number;
  y: number;
}

class EntriesHost extends Entity {
  public override isPointInside(): boolean {
    return false;
  }
  public override render(_r: IRenderer): void {}
}

/**
 * Plasma-style task manager: Kickoff button + one entry per open window.
 * Click focuses/restores; click-on-active minimizes (Plasma Task Manager).
 */
export class Taskbar extends UIComponent {
  private readonly registry: AppRegistry;
  private readonly wm: WindowManager;
  private readonly chrome: TaskbarChrome;
  private readonly onToggleStart: () => void;
  private readonly bar: Card;
  private readonly startBtn: Button;
  private readonly entriesHost: Entity;
  private readonly unsub: () => void;
  private entryButtons: Button[] = [];

  constructor(opts: TaskbarOptions) {
    super();
    this.registry = opts.registry;
    this.wm = opts.windowManager;
    this.chrome = opts.chrome;
    this.onToggleStart = opts.onToggleStart;

    this.width = opts.width;
    this.height = opts.chrome.height;
    this.x = 0;
    this.y = opts.y;
    this.interactive = true;
    this.a11yProjection = 'eager';

    this.bar = new Card({
      width: this.width,
      height: this.height,
      bg: this.chrome.bg,
      radius: 0,
      borderWidth: 0,
    });
    this.bar.getA11yAttributes = () => ({ pointerEvents: 'none' });
    this.bar.a11yProjection = 'never';
    this.add(this.bar);

    this.startBtn = new Button('Start', {
      bg: this.chrome.active,
      hoverBg: this.chrome.hover,
      color: this.chrome.fg,
      font: '600 14px sans-serif',
      padding: 6,
      radius: 6,
      width: 54,
      height: Math.max(28, this.height - 8),
      onClick: () => this.onToggleStart(),
    });
    this.startBtn.a11yProjection = 'eager';
    this.startBtn.x = 8;
    this.startBtn.y = (this.height - this.startBtn.height) / 2;
    const startA11y = this.startBtn.getA11yAttributes.bind(this.startBtn);
    this.startBtn.getA11yAttributes = () => ({
      ...startA11y(),
      label: 'Start',
    });
    this.bar.add(this.startBtn);

    this.entriesHost = new EntriesHost();
    this.entriesHost.x = 70;
    this.entriesHost.y = 0;
    this.entriesHost.width = Math.max(0, this.width - 78);
    this.entriesHost.height = this.height;
    this.entriesHost.a11yProjection = 'never';
    this.bar.add(this.entriesHost);

    this.unsub = this.wm.on(() => this.rebuild());
    this.rebuild();
  }

  public override getA11yAttributes(): A11yAttributes {
    return { role: 'toolbar', label: 'Taskbar' };
  }

  public setGeometry(width: number, y: number): void {
    this.width = width;
    this.y = y;
    this.bar.width = width;
    this.entriesHost.width = Math.max(0, width - 78);
    this.rebuild();
  }

  public rebuild(): void {
    for (const b of this.entryButtons) {
      this.entriesHost.remove(b);
      b.destroy();
    }
    this.entryButtons = [];

    const windows = this.wm.list();
    const btnH = Math.max(28, this.height - 8);
    const btnY = (this.height - btnH) / 2;
    let x = 0;
    const maxW = 160;
    const gap = 6;

    for (const win of windows) {
      const app = this.registry.get(win.appId);
      const label = app?.icon ? `${app.icon} ${win.title}` : win.title;
      const focused = this.wm.focusedWindow === win && !win.minimized;
      const bg = focused ? this.chrome.active : win.minimized ? this.chrome.hover : this.chrome.bg;
      const btn = new Button(truncate(label, 18), {
        bg,
        hoverBg: this.chrome.hover,
        color: this.chrome.fg,
        font: '600 12px sans-serif',
        padding: 8,
        radius: 6,
        height: btnH,
        onClick: () => this.onEntryClick(win),
      });
      btn.a11yProjection = 'eager';
      btn.width = Math.min(maxW, Math.max(72, btn.width));
      btn.x = x;
      btn.y = btnY;
      const a11y = btn.getA11yAttributes.bind(btn);
      btn.getA11yAttributes = () => ({
        ...a11y(),
        label: win.title,
        selected: focused,
      });
      this.entriesHost.add(btn);
      this.entryButtons.push(btn);
      x += btn.width + gap;
      if (x > this.entriesHost.width) break;
    }
    this.scene?.markDirty();
  }

  private onEntryClick(win: DesktopWindow): void {
    if (this.wm.focusedWindow === win && !win.minimized) {
      win.minimize();
      return;
    }
    this.wm.focus(win);
  }

  public override destroy(): void {
    this.unsub();
    super.destroy();
  }

  public override render(_r: IRenderer): void {}
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
