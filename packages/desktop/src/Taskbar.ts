import { type A11yAttributes, Entity, type IRenderer, type Scene } from '@vectojs/core';
import { Button, Card, Text, UIComponent } from '@vectojs/ui';
import type { DesktopWindow } from './Window';
import type { WindowManager } from './WindowManager';
import { addButtonIcon } from './icon';

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
 * Plasma-style task manager: Kickoff button + one entry per open window + clock.
 * Click focuses/restores; click-on-active minimizes (Plasma Task Manager).
 */
export class Taskbar extends UIComponent {
  private readonly wm: WindowManager;
  private readonly chrome: TaskbarChrome;
  private readonly onToggleStart: () => void;
  private readonly bar: Card;
  private readonly startBtn: Button;
  private readonly clockLabel: Text;
  private readonly entriesHost: Entity;
  private readonly unsub: () => void;
  private timer: number | null = null;
  private clockText = '';
  private readonly entryButtons = new Map<DesktopWindow, Button>();

  constructor(opts: TaskbarOptions) {
    super();
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

    this.clockLabel = new Text('', {
      font: '600 12px sans-serif',
      color: this.chrome.fg,
      selectable: false,
    });
    this.clockLabel.interactive = false;
    this.clockLabel.a11yProjection = 'never';
    this.bar.add(this.clockLabel);

    this.entriesHost = new EntriesHost();
    this.entriesHost.x = 70;
    this.entriesHost.y = 0;
    this.entriesHost.width = Math.max(0, this.width - 150);
    this.entriesHost.height = this.height;
    this.entriesHost.a11yProjection = 'never';
    this.bar.add(this.entriesHost);

    this.updateClock();
    if (typeof window !== 'undefined') {
      this.timer = window.setInterval(() => this.updateClock(), 1000);
    }

    this.unsub = this.wm.on(() => this.rebuild());
    this.rebuild();
  }

  private updateClock(): void {
    const d = new Date();
    // hh:mm only changes once a minute — 59 of 60 interval ticks are no-ops
    // that must not wake an onDemand scene.
    const s = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (s === this.clockText) return;
    this.clockText = s;
    this.clockLabel.setText(s);
    this.clockLabel.x = Math.max(0, this.width - 64);
    this.clockLabel.y = (this.height - 14) / 2;
    this.scene?.markDirty();
  }

  /** Right edge of the Start button in taskbar-local coordinates. */
  public get startButtonRight(): number {
    return this.startBtn.x + this.startBtn.width;
  }

  public override getA11yAttributes(): A11yAttributes {
    // Structural only — full-bar auto mirror would steal clicks from Start /
    // task buttons and force cursor:pointer across empty taskbar chrome.
    return { role: 'toolbar', label: 'Taskbar', pointerEvents: 'none' };
  }

  public setGeometry(width: number, y: number): void {
    this.width = width;
    this.y = y;
    this.bar.width = width;
    this.entriesHost.width = Math.max(0, width - 150);
    this.updateClock();
    this.rebuild();
  }

  public rebuild(): void {
    // Shell dialogs are transient prompts, not tasks: never listed.
    const windows = this.wm.list().filter((w) => !w.isDialog);
    const btnH = Math.max(28, this.height - 8);
    const btnY = (this.height - btnH) / 2;
    const maxW = 160;
    const gap = 6;
    const live = new Set<DesktopWindow>();

    let x = 0;
    for (const win of windows) {
      const focused = this.wm.focusedWindow === win && !win.minimized;
      const bg = focused ? this.chrome.active : win.minimized ? this.chrome.hover : this.chrome.bg;
      let btn = this.entryButtons.get(win);
      if (!btn) {
        const label = win.title;
        btn = new Button(truncate(label, 20), {
          bg,
          hoverBg: this.chrome.hover,
          color: this.chrome.fg,
          font: '600 12px "Segoe UI", system-ui, sans-serif',
          padding: 10,
          radius: 4,
          height: btnH,
          onClick: () => this.onEntryClick(win),
        });
        if (win.appIconSvg) {
          btn.width = Math.min(maxW, Math.max(88, btn.width + 24));
          addButtonIcon(btn, win.appIconSvg, 16, this.chrome.fg);
        }
        btn.a11yProjection = 'eager';
        btn.width = Math.min(maxW, Math.max(88, btn.width));
        btn.y = btnY;
        const a11y = btn.getA11yAttributes.bind(btn);
        btn.getA11yAttributes = () => ({
          ...a11y(),
          label: win.title,
          // Live state: the previous build captured `focused` per rebuild,
          // which forced a full destroy/recreate on every focus change.
          selected: this.wm.focusedWindow === win && !win.minimized,
        });
        this.entriesHost.add(btn);
        this.entryButtons.set(win, btn);
      } else {
        btn.bg = bg;
        btn.y = btnY;
      }
      btn.x = x;
      live.add(win);
      x += btn.width + gap;
      if (x > this.entriesHost.width) break;
    }

    for (const [win, btn] of this.entryButtons) {
      if (live.has(win)) continue;
      this.entriesHost.remove(btn);
      btn.destroy();
      this.entryButtons.delete(win);
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
    if (this.timer !== null && typeof window !== 'undefined') {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.unsub();
    super.destroy();
  }

  public override render(_r: IRenderer): void {}
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
