import type { Scene } from '@vectojs/core';
import type { AppRegistry } from './AppRegistry';
import { DesktopWindow, type WindowChrome } from './Window';

export interface OpenWindowOptions {
  title?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
}

/**
 * Owns open {@link DesktopWindow} instances: open / focus / close / z-order.
 * Windows live on the scene overlay layer so they float above the wallpaper.
 */
export class WindowManager {
  private readonly scene: Scene;
  private readonly registry: AppRegistry;
  private readonly chrome: WindowChrome;
  private readonly windows: DesktopWindow[] = [];
  private focused: DesktopWindow | null = null;
  private cascade = 0;

  constructor(scene: Scene, registry: AppRegistry, chrome: WindowChrome) {
    this.scene = scene;
    this.registry = registry;
    this.chrome = chrome;
  }

  /** Currently focused window, if any. */
  get focusedWindow(): DesktopWindow | null {
    return this.focused;
  }

  /** Snapshot of open windows, bottom → top. */
  list(): readonly DesktopWindow[] {
    return this.windows;
  }

  /**
   * Open an app by id. Throws if the app is not registered.
   * Returns the existing focused window if the same app is already open
   * (single-instance default for the skeleton).
   */
  open(appId: string, opts: OpenWindowOptions = {}): DesktopWindow {
    const existing = this.windows.find((w) => w.appId === appId);
    if (existing) {
      this.focus(existing);
      return existing;
    }

    const app = this.registry.get(appId);
    if (!app) {
      throw new Error(`WindowManager.open: unknown app id '${appId}'`);
    }

    const offset = (this.cascade++ % 8) * 24;
    const win = new DesktopWindow({
      app,
      title: opts.title,
      width: opts.width,
      height: opts.height,
      x: opts.x ?? 64 + offset,
      y: opts.y ?? 64 + offset,
      chrome: this.chrome,
      onClose: (w) => this.close(w),
      onFocus: (w) => this.focus(w),
    });

    this.scene.showOverlay(win);
    win.bindScene(this.scene);
    this.windows.push(win);
    this.focus(win);
    return win;
  }

  /** Bring a window to the front and mark it focused. */
  focus(win: DesktopWindow): void {
    if (!this.windows.includes(win)) return;
    if (this.focused === win) {
      // Still restack in case z-order drifted.
      this.restack(win);
      return;
    }
    if (this.focused) this.focused.setFocused(false);
    this.focused = win;
    win.setFocused(true);
    this.restack(win);
    this.scene.requestA11yProjection(win);
    this.scene.markDirty();
  }

  /** Close and destroy a window. */
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

    const next = this.windows[this.windows.length - 1];
    if (next) this.focus(next);
    else this.scene.markDirty();
  }

  /** Close every open window. */
  closeAll(): void {
    for (const w of [...this.windows]) this.close(w);
  }

  private restack(win: DesktopWindow): void {
    // Overlay z-order is sibling order: remove + re-add moves to top.
    const root = this.scene.overlayRoot;
    if (!root.children.includes(win)) return;
    root.remove(win);
    root.add(win);
  }
}
