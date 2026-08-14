import type { Scene } from '@vectojs/core';
import type { AppRegistry } from './AppRegistry';
import type { DisplayLayout } from './DisplayLayout';
import type { Vfs } from './Vfs';
import { DesktopWindow, type WindowChrome } from './Window';

export interface OpenWindowOptions {
  title?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  /** Target display id; default primary. */
  displayId?: string;
  /**
   * Force a new instance even when the app policy is `'single'`.
   * Ignored when policy is already `'multiple'`.
   */
  forceNew?: boolean;
}

export type WindowManagerListener = (event: {
  type: 'open' | 'close' | 'focus' | 'state';
  window: DesktopWindow;
}) => void;

/**
 * Owns open {@link DesktopWindow} instances (KWin-like):
 * open / focus / close / z-order / multi-instance policy.
 */
export class WindowManager {
  private readonly scene: Scene;
  private readonly registry: AppRegistry;
  private readonly chrome: WindowChrome;
  private readonly layout: DisplayLayout;
  private readonly vfs: Vfs | null;
  private readonly windows: DesktopWindow[] = [];
  private focused: DesktopWindow | null = null;
  private cascade = 0;
  private seq = 0;
  private readonly listeners = new Set<WindowManagerListener>();

  constructor(
    scene: Scene,
    registry: AppRegistry,
    chrome: WindowChrome,
    layout: DisplayLayout,
    vfs: Vfs | null = null,
  ) {
    this.scene = scene;
    this.registry = registry;
    this.chrome = chrome;
    this.layout = layout;
    this.vfs = vfs;
  }

  get focusedWindow(): DesktopWindow | null {
    return this.focused;
  }

  list(): readonly DesktopWindow[] {
    return this.windows;
  }

  /** Windows for one app id (task manager grouping). */
  listByApp(appId: string): DesktopWindow[] {
    return this.windows.filter((w) => w.appId === appId);
  }

  on(listener: WindowManagerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Open an app by id.
   * - `instances: 'single'` (default): focus existing window unless `forceNew`.
   * - `instances: 'multiple'`: always spawn.
   */
  open(appId: string, opts: OpenWindowOptions = {}): DesktopWindow {
    const app = this.registry.get(appId);
    if (!app) {
      throw new Error(`WindowManager.open: unknown app id '${appId}'`);
    }

    const policy = app.instances ?? 'single';
    if (policy === 'single' && !opts.forceNew) {
      const existing = this.windows.find((w) => w.appId === appId);
      if (existing) {
        if (existing.minimized) existing.restoreFromMinimized();
        this.focus(existing);
        return existing;
      }
    }

    const displayId = opts.displayId ?? this.layout.primary().id;
    const area = this.layout.workArea(displayId);
    const offset = (this.cascade++ % 8) * 28;
    const width = opts.width ?? app.defaultWidth ?? 480;
    const height = opts.height ?? app.defaultHeight ?? 340;
    const x = opts.x ?? area.x + 64 + offset;
    const y = opts.y ?? area.y + 64 + offset;
    const clamped = this.layout.clampRect(x, y, width, height, displayId);

    const windowId = `${appId}-${++this.seq}`;
    const win = new DesktopWindow({
      app,
      windowId,
      title: opts.title,
      width: clamped.width,
      height: clamped.height,
      x: clamped.x,
      y: clamped.y,
      chrome: this.chrome,
      scene: this.scene,
      vfs: this.vfs,
      workArea: () => this.layout.workArea(displayId),
      onClose: (w) => this.close(w),
      onFocus: (w) => this.focus(w),
      onStateChange: (w) => this.handleWindowStateChange(w),
    });

    this.scene.showOverlay(win);
    this.windows.push(win);
    this.focus(win);
    this.emit('open', win);
    return win;
  }

  focus(win: DesktopWindow): void {
    if (!this.windows.includes(win)) return;
    if (win.minimized) win.restoreFromMinimized();
    if (this.focused === win) {
      this.restack(win);
      return;
    }
    if (this.focused) {
      this.focused.setFocused(false);
      // Drop the previous window's pinned projection so onDemand background
      // windows do not keep a permanent a11y mirror after blur.
      this.scene.releaseA11yProjection(this.focused);
    }
    this.focused = win;
    win.setFocused(true);
    this.restack(win);
    this.scene.requestA11yProjection(win);
    this.scene.markDirty();
    this.emit('focus', win);
  }

  close(win: DesktopWindow): void {
    const idx = this.windows.indexOf(win);
    if (idx < 0) return;
    this.windows.splice(idx, 1);
    if (this.focused === win) {
      this.scene.releaseA11yProjection(win);
      this.focused = null;
    }
    this.scene.hideOverlay(win);
    win.destroy();
    this.emit('close', win);

    const next = [...this.windows].reverse().find((w) => !w.minimized);
    if (next) this.focus(next);
    else this.scene.markDirty();
  }

  closeFocused(): void {
    if (this.focused) this.close(this.focused);
  }

  closeAll(): void {
    for (const w of [...this.windows]) this.close(w);
  }

  /** Cycle focus through non-minimized windows (Alt+Tab lite). */
  cycleFocus(backward = false): void {
    const live = this.windows.filter((w) => !w.minimized);
    if (live.length === 0) return;
    const cur = this.focused && live.includes(this.focused) ? this.focused : live[live.length - 1]!;
    const i = live.indexOf(cur);
    const next = backward
      ? live[(i - 1 + live.length) % live.length]!
      : live[(i + 1) % live.length]!;
    this.focus(next);
  }

  private restack(win: DesktopWindow): void {
    // Reorder siblings without Entity.remove() — remove() detaches a11y and
    // unregisters drivers, which would thrash every focus change.
    const root = this.scene.overlayRoot;
    const kids = root.children;
    const idx = kids.indexOf(win);
    if (idx < 0 || idx === kids.length - 1) return;
    kids.splice(idx, 1);
    kids.push(win);
    this.scene.markStructureChanged();
    this.scene.markDirty();
  }

  private handleWindowStateChange(win: DesktopWindow): void {
    if (win.minimized && this.focused === win) {
      win.setFocused(false);
      this.scene.releaseA11yProjection(win);
      this.focused = null;
      const next = [...this.windows].reverse().find((w) => !w.minimized);
      if (next) {
        this.focus(next);
      } else {
        this.scene.markDirty();
      }
    }
    this.emit('state', win);
  }

  private emit(type: 'open' | 'close' | 'focus' | 'state', window: DesktopWindow): void {
    for (const l of this.listeners) l({ type, window });
  }
}
