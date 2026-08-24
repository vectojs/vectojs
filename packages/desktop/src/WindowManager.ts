import { type Entity, type Scene } from '@vectojs/core';
import type { AppRegistry } from './AppRegistry';
import type { DisplayLayout } from './DisplayLayout';
import type { Vfs } from './Vfs';
import type { AppContext } from './types';
import {
  DesktopWindow,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  type WindowChrome,
} from './Window';

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
 * Options for {@link WindowManager.openDialog}: a floating, optionally-modal
 * shell window that needs NO AppRegistry entry (confirm prompts, pickers,
 * transient forms). Dialogs are excluded from taskbar entries and carry
 * close-only chrome (no resize/maximize/minimize).
 */
export interface OpenDialogOptions {
  /** Titlebar text and accessible name of the dialog. */
  title: string;
  width?: number;
  height?: number;
  /** Top-left position; omitted → centered on the primary work area. */
  x?: number;
  y?: number;
  /**
   * Client content: a ready entity, or a builder receiving the dialog's
   * {@link AppContext} (`ctx.close()` dismisses the dialog).
   */
  content: Entity | ((ctx: AppContext) => Entity);
  /** Block refocusing other windows while open. Default true. */
  modal?: boolean;
  /** Escape closes the dialog. Default true. */
  dismissible?: boolean;
}

/** Internal pseudo app id for dialogs opened via {@link WindowManager.openDialog}. */
const DIALOG_APP_ID = 'dialog';

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
  /** Open dialogs in open order (last = topmost). */
  private readonly dialogOrder: DesktopWindow[] = [];
  /** Focus holder when a dialog opened; restored on close. */
  private readonly dialogPrevFocus = new Map<DesktopWindow, DesktopWindow | null>();
  private readonly onDocKeyDown = (e: KeyboardEvent) => this.handleDocKeyDown(e);

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

  public setChrome(chrome: WindowChrome): void {
    Object.assign(this.chrome, chrome);
    for (const win of this.windows) {
      win.updateChrome(chrome);
    }
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
    const width = opts.width ?? app.defaultWidth ?? DEFAULT_WINDOW_WIDTH;
    const height = opts.height ?? app.defaultHeight ?? DEFAULT_WINDOW_HEIGHT;
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
      windowManager: this,
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

  /**
   * Open a shell dialog WITHOUT an AppRegistry entry: close-only chrome,
   * no resize/maximize/minimize, excluded from taskbar entries. Modal dialogs
   * hold focus while open; closing restores focus to the window focused
   * before the dialog opened. When `x`/`y` are omitted the dialog is centered
   * on the work area (clamped to fit).
   */
  openDialog(opts: OpenDialogOptions): DesktopWindow {
    const modal = opts.modal ?? true;
    const dismissible = opts.dismissible ?? true;
    const displayId = this.layout.primary().id;
    const area = this.layout.workArea(displayId);
    const width = opts.width ?? DEFAULT_WINDOW_WIDTH;
    const height = opts.height ?? DEFAULT_WINDOW_HEIGHT;
    const x = opts.x ?? area.x + Math.round((area.width - width) / 2);
    const y = opts.y ?? area.y + Math.round((area.height - height) / 2);
    const clamped = this.layout.clampRect(x, y, width, height, displayId);

    const prevFocus = this.focused;
    const pseudoApp = {
      id: DIALOG_APP_ID,
      title: opts.title,
      create: (ctx: AppContext): Entity =>
        typeof opts.content === 'function' ? opts.content(ctx) : opts.content,
    };
    const win = new DesktopWindow({
      app: pseudoApp,
      windowId: `${DIALOG_APP_ID}-${++this.seq}`,
      title: opts.title,
      width: clamped.width,
      height: clamped.height,
      x: clamped.x,
      y: clamped.y,
      chrome: this.chrome,
      scene: this.scene,
      vfs: this.vfs,
      windowManager: this,
      workArea: () => this.layout.workArea(displayId),
      onClose: (w) => this.close(w),
      onFocus: (w) => this.focus(w),
      onStateChange: (w) => this.handleWindowStateChange(w),
      dialog: { modal, dismissible },
    });

    // Register before focus so the modality gate recognizes the new dialog.
    this.dialogOrder.push(win);
    this.dialogPrevFocus.set(win, prevFocus);
    if (this.dialogOrder.length === 1) this.attachEscape();

    this.scene.showOverlay(win);
    this.windows.push(win);
    this.focus(win);
    this.emit('open', win);
    return win;
  }

  focus(win: DesktopWindow): void {
    if (!this.windows.includes(win)) return;
    // Modal dialog holds focus: click-driven or programmatic refocus of any
    // other window (including lower ones) is blocked until it closes.
    const topModal = this.topModal();
    if (topModal && win !== topModal) return;
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
    const dialogIdx = this.dialogOrder.indexOf(win);
    let restoreTo: DesktopWindow | null = null;
    if (dialogIdx >= 0) {
      this.dialogOrder.splice(dialogIdx, 1);
      restoreTo = this.dialogPrevFocus.get(win) ?? null;
      this.dialogPrevFocus.delete(win);
      if (this.dialogOrder.length === 0) this.detachEscape();
    }
    if (this.focused === win) {
      this.scene.releaseA11yProjection(win);
      this.focused = null;
    }
    this.scene.hideOverlay(win);
    win.destroy();
    this.emit('close', win);

    let next = [...this.windows].reverse().find((w) => !w.minimized);
    // A closed dialog hands focus back to its opener, not to whatever is
    // topmost underneath it.
    if (restoreTo && this.windows.includes(restoreTo) && !restoreTo.minimized) {
      next = restoreTo;
    }
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
    // A modal dialog holds focus: cycling would move it to a lower window.
    if (this.topModal()) return;
    const live = this.windows.filter((w) => !w.minimized);
    if (live.length === 0) return;
    const cur = this.focused && live.includes(this.focused) ? this.focused : live[live.length - 1]!;
    const i = live.indexOf(cur);
    const next = backward
      ? live[(i - 1 + live.length) % live.length]!
      : live[(i + 1) % live.length]!;
    this.focus(next);
  }

  /** Topmost open modal dialog, or null when no modal dialog is open. */
  private topModal(): DesktopWindow | null {
    for (let i = this.dialogOrder.length - 1; i >= 0; i--) {
      const w = this.dialogOrder[i]!;
      if (w.modal) return w;
    }
    return null;
  }

  private attachEscape(): void {
    if (typeof document === 'undefined') return;
    document.addEventListener('keydown', this.onDocKeyDown, true);
  }

  private detachEscape(): void {
    if (typeof document === 'undefined') return;
    document.removeEventListener('keydown', this.onDocKeyDown, true);
  }

  private handleDocKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    const top = this.dialogOrder[this.dialogOrder.length - 1];
    // Only dismissible dialogs respond to Escape (topmost wins).
    if (!top || !top.dismissible) return;
    e.preventDefault();
    e.stopPropagation();
    this.close(top);
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
