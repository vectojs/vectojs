import { Entity, type IRenderer, type Scene } from '@vectojs/core';
import { setTheme, tokens } from '@vectojs/styles';
import { AppRegistry } from './AppRegistry';
import { DisplayLayout } from './DisplayLayout';
import { resolveConfig } from './resolveConfig';
import { ShortcutRouter } from './ShortcutRouter';
import { StartMenu } from './StartMenu';
import { Taskbar } from './Taskbar';
import type { ResolvedWebosConfig, ShortcutAction, WebosConfig } from './types';
import type { Vfs } from './Vfs';
import { type WindowChrome } from './Window';
import { WindowManager } from './WindowManager';

/**
 * Wallpaper — solid fill + optional cover image (Plasma desktop background).
 */
class Wallpaper extends Entity {
  public color: string;
  private bitmap: HTMLImageElement | null = null;
  private loaded = false;

  constructor(color: string, imageUrl: string | null, onLoad?: () => void) {
    super();
    this.color = color;
    this.interactive = false;
    this.a11yProjection = 'never';
    if (imageUrl && typeof globalThis.Image !== 'undefined') {
      const bmp = new globalThis.Image();
      bmp.onload = () => {
        this.loaded = true;
        onLoad?.();
      };
      bmp.src = imageUrl;
      this.bitmap = bmp;
    }
  }

  public override isPointInside(): boolean {
    return false;
  }

  public override render(r: IRenderer): void {
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, 0);
    r.fill(this.color);
    if (this.bitmap && this.loaded && this.bitmap.naturalWidth > 0) {
      // object-fit: cover
      const iw = this.bitmap.naturalWidth;
      const ih = this.bitmap.naturalHeight;
      const scale = Math.max(this.width / iw, this.height / ih);
      const dw = iw * scale;
      const dh = ih * scale;
      const dx = (this.width - dw) / 2;
      const dy = (this.height - dh) / 2;
      r.drawImage(this.bitmap, dx, dy, dw, dh);
    }
  }
}

export interface DesktopShellOptions {
  scene: Scene;
  config?: WebosConfig;
  /** Optional handler for `{ type: 'custom' }` shortcuts. */
  onCustomShortcut?: (id: string, chord: string) => void;
}

/**
 * Top-level WebOS host (Plasma-inspired):
 * wallpaper + multi-display work areas + taskbar/Kickoff + KWin-like WM +
 * shortcut router + optional VFS.
 */
export class DesktopShell {
  public readonly scene: Scene;
  public readonly config: ResolvedWebosConfig;
  public readonly registry: AppRegistry;
  public readonly windowManager: WindowManager;
  public readonly layout: DisplayLayout;
  public readonly vfs: Vfs | null;
  public readonly shortcuts: ShortcutRouter;

  private readonly wallpaper: Wallpaper;
  private taskbar: Taskbar | null = null;
  private startMenu: StartMenu | null = null;
  private started = false;
  private disposed = false;
  private readonly onCustomShortcut?: (id: string, chord: string) => void;
  private readonly onDocPointerDown: (e: PointerEvent) => void;
  private readonly onDocKeyDown: (e: KeyboardEvent) => void;

  constructor(opts: DesktopShellOptions) {
    this.scene = opts.scene;
    this.config = resolveConfig(opts.config);
    this.registry = new AppRegistry(this.config.apps);
    this.vfs = this.config.vfs;
    this.onCustomShortcut = opts.onCustomShortcut;

    setTheme(tokens(this.config.theme));

    const sw = this.scene.width || 800;
    const sh = this.scene.height || 600;
    this.layout = new DisplayLayout(
      this.config.desktop.displays,
      sw,
      sh,
      this.config.desktop.taskbarHeight,
      this.config.desktop.taskbarPosition,
    );

    const chrome = resolveChrome(this.config);
    this.windowManager = new WindowManager(
      this.scene,
      this.registry,
      chrome,
      this.layout,
      this.vfs,
    );

    this.wallpaper = new Wallpaper(
      this.config.desktop.wallpaper,
      this.config.desktop.wallpaperImage,
      () => this.scene.markDirty(),
    );
    this.syncWallpaperSize();

    this.shortcuts = new ShortcutRouter(this.config.shortcuts);
    this.shortcuts.setHandler((action, chord) => this.dispatchShortcut(action, chord));

    this.onDocPointerDown = (e) => this.handleOutsidePointer(e);
    this.onDocKeyDown = (e) => {
      if (e.key === 'Escape' && this.startMenu) {
        this.closeStartMenu();
      }
    };
  }

  /** Mount wallpaper, taskbar, shortcuts. Idempotent. */
  start(): void {
    this.assertLive();
    if (this.started) return;
    this.scene.add(this.wallpaper);
    this.syncLayoutToScene();
    this.mountTaskbar();
    this.shortcuts.attach();
    if (typeof document !== 'undefined') {
      document.addEventListener('pointerdown', this.onDocPointerDown, true);
      document.addEventListener('keydown', this.onDocKeyDown, true);
    }
    this.started = true;
    this.scene.markDirty();
  }

  /**
   * Re-sync wallpaper / taskbar / primary display after the host Scene is
   * resized. Call from the app's resize path (Scene has no resize event bus).
   */
  syncLayoutToScene(): void {
    this.assertLive();
    const sw = this.scene.width || 800;
    const sh = this.scene.height || 600;
    this.layout.updateSceneSize(sw, sh);
    this.syncWallpaperSize();
    if (this.taskbar) {
      const bounds = this.layout.bounds();
      const h = this.config.desktop.taskbarHeight;
      const y =
        this.config.desktop.taskbarPosition === 'top' ? bounds.y : bounds.y + bounds.height - h;
      this.taskbar.setGeometry(bounds.width, y);
    }
  }

  open(appId: string, opts?: Parameters<WindowManager['open']>[1]) {
    this.assertLive();
    if (!this.started) this.start();
    this.closeStartMenu();
    return this.windowManager.open(appId, opts);
  }

  toggleStartMenu(): void {
    this.assertLive();
    if (!this.started) this.start();
    if (this.startMenu) this.closeStartMenu();
    else this.openStartMenu();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.shortcuts.detach();
    if (typeof document !== 'undefined') {
      document.removeEventListener('pointerdown', this.onDocPointerDown, true);
      document.removeEventListener('keydown', this.onDocKeyDown, true);
    }
    this.closeStartMenu();
    this.windowManager.closeAll();
    if (this.taskbar) {
      if (this.taskbar.parent) this.scene.remove(this.taskbar);
      this.taskbar.destroy();
      this.taskbar = null;
    }
    if (this.wallpaper.parent) this.scene.remove(this.wallpaper);
    this.wallpaper.destroy();
    this.started = false;
  }

  private mountTaskbar(): void {
    const h = this.config.desktop.taskbarHeight;
    if (h <= 0) return;
    const bounds = this.layout.bounds();
    const y =
      this.config.desktop.taskbarPosition === 'top' ? bounds.y : bounds.y + bounds.height - h;
    const t = this.config.theme;
    this.taskbar = new Taskbar({
      scene: this.scene,
      registry: this.registry,
      windowManager: this.windowManager,
      chrome: {
        bg: str(t, 'desktop-taskbar-bg', '#0f172a'),
        fg: str(t, 'desktop-taskbar-fg', '#e2e8f0'),
        hover: str(t, 'desktop-taskbar-hover', '#1e293b'),
        active: str(t, 'desktop-taskbar-active', '#1d4ed8'),
        height: h,
        position: this.config.desktop.taskbarPosition,
      },
      onToggleStart: () => this.toggleStartMenu(),
      width: bounds.width,
      y,
    });
    this.scene.add(this.taskbar);
  }

  private openStartMenu(): void {
    if (this.startMenu) return;
    const apps = this.registry.list();
    const t = this.config.theme;
    const bounds = this.layout.bounds();
    const tbH = this.config.desktop.taskbarHeight;
    const menuW = 240;
    // Position using a temporary geometry estimate; refine with the live
    // entity height after construction so shell and StartMenu cannot drift.
    const estH = 36 + 8 + apps.length * (36 + 4) + 8;
    const x = bounds.x + 8;
    let y =
      this.config.desktop.taskbarPosition === 'top'
        ? bounds.y + tbH + 4
        : bounds.y + bounds.height - tbH - estH - 4;

    this.startMenu = new StartMenu({
      scene: this.scene,
      apps,
      chrome: {
        bg: str(t, 'desktop-start-bg', '#1e293b'),
        border: str(t, 'desktop-start-border', '#334155'),
        fg: str(t, 'desktop-taskbar-fg', '#e2e8f0'),
        hover: str(t, 'desktop-taskbar-hover', '#1e293b'),
        radius: num(t, 'desktop-radius', 10),
      },
      onLaunch: (id) => this.open(id),
      onClose: () => this.closeStartMenu(),
      x,
      y,
      width: menuW,
    });
    if (this.config.desktop.taskbarPosition !== 'top') {
      y = bounds.y + bounds.height - tbH - this.startMenu.height - 4;
      this.startMenu.y = y;
    }
    this.scene.showOverlay(this.startMenu);
    this.scene.requestA11yProjection(this.startMenu);
    this.scene.markDirty();
  }

  private closeStartMenu(): void {
    if (!this.startMenu) return;
    this.scene.releaseA11yProjection(this.startMenu);
    this.scene.hideOverlay(this.startMenu);
    this.startMenu.destroy();
    this.startMenu = null;
    this.scene.markDirty();
  }

  private dispatchShortcut(action: ShortcutAction, chord: string): void {
    switch (action.type) {
      case 'open-app':
        this.open(action.appId);
        break;
      case 'close-focused':
        this.windowManager.closeFocused();
        break;
      case 'toggle-start':
        this.toggleStartMenu();
        break;
      case 'custom':
        this.onCustomShortcut?.(action.id, chord);
        break;
    }
  }

  private handleOutsidePointer(e: PointerEvent): void {
    if (!this.startMenu) return;
    // Close Kickoff when pressing outside the menu entity's box.
    const menu = this.startMenu;
    const pt =
      typeof this.scene.clientToScene === 'function'
        ? this.scene.clientToScene(e.clientX ?? 0, e.clientY ?? 0)
        : { x: e.clientX ?? 0, y: e.clientY ?? 0 };
    const lx = pt.x;
    const ly = pt.y;
    if (lx < menu.x || lx > menu.x + menu.width || ly < menu.y || ly > menu.y + menu.height) {
      // Don't close when pressing the start button (toggle handles it).
      if (this.taskbar) {
        const tb = this.taskbar;
        if (lx >= tb.x && lx <= tb.x + 64 && ly >= tb.y && ly <= tb.y + tb.height) {
          return;
        }
      }
      this.closeStartMenu();
    }
  }

  private syncWallpaperSize(): void {
    const b = this.layout.bounds();
    this.wallpaper.x = b.x;
    this.wallpaper.y = b.y;
    this.wallpaper.width = b.width || this.scene.width || 800;
    this.wallpaper.height = b.height || this.scene.height || 600;
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('DesktopShell has been disposed');
  }
}

function num(t: ResolvedWebosConfig['theme'], key: string, fallback: number): number {
  const v = t[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function str(t: ResolvedWebosConfig['theme'], key: string, fallback: string): string {
  const v = t[key];
  return typeof v === 'string' ? v : fallback;
}

function resolveChrome(config: ResolvedWebosConfig): WindowChrome {
  const t = config.theme;
  return {
    windowBg: str(t, 'desktop-window-bg', '#0f172a'),
    windowBorder: str(t, 'desktop-window-border', '#334155'),
    titlebarBg: str(t, 'desktop-titlebar-bg', '#1e293b'),
    titlebarFg: str(t, 'desktop-titlebar-fg', '#e2e8f0'),
    titlebarHeight: num(t, 'desktop-titlebar-height', 32),
    closeBg: str(t, 'desktop-close-bg', '#334155'),
    closeFg: str(t, 'desktop-close-fg', '#e2e8f0'),
    focusRing: str(t, 'desktop-focus-ring', '#38bdf8'),
    radius: num(t, 'desktop-radius', 10),
    resizeHandle: num(t, 'desktop-resize-handle', 6),
    minWidth: num(t, 'desktop-min-width', 200),
    minHeight: num(t, 'desktop-min-height', 120),
  };
}
