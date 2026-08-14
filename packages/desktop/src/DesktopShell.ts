import { Entity, type IRenderer, type Scene } from '@vectojs/core';
import { setTheme, tokens } from '@vectojs/styles';
import { AppRegistry } from './AppRegistry';
import { resolveConfig } from './resolveConfig';
import type { ResolvedWebosConfig, WebosConfig } from './types';
import { type WindowChrome } from './Window';
import { WindowManager } from './WindowManager';

/**
 * Wallpaper entity — fills the scene with the configured colour.
 * Non-interactive; no a11y projection.
 */
class Wallpaper extends Entity {
  public color: string;

  constructor(color: string) {
    super();
    this.color = color;
    this.interactive = false;
    this.a11yProjection = 'never';
  }

  public override isPointInside(): boolean {
    return false;
  }

  public override render(r: IRenderer): void {
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, 0);
    r.fill(this.color);
  }
}

export interface DesktopShellOptions {
  scene: Scene;
  config?: WebosConfig;
}

/**
 * Top-level WebOS host: applies config, mounts wallpaper, owns registry + WM.
 *
 * ```ts
 * const shell = new DesktopShell({
 *   scene,
 *   config: {
 *     apps: [{ id: 'about', title: 'About', create: () => new Text('hi') }],
 *   },
 * });
 * shell.start();
 * shell.windowManager.open('about');
 * ```
 */
export class DesktopShell {
  public readonly scene: Scene;
  public readonly config: ResolvedWebosConfig;
  public readonly registry: AppRegistry;
  public readonly windowManager: WindowManager;

  private readonly wallpaper: Wallpaper;
  private started = false;
  private disposed = false;

  constructor(opts: DesktopShellOptions) {
    this.scene = opts.scene;
    this.config = resolveConfig(opts.config);
    this.registry = new AppRegistry(this.config.apps);

    setTheme(tokens(this.config.theme));

    const chrome = resolveChrome(this.config);
    this.windowManager = new WindowManager(this.scene, this.registry, chrome);

    this.wallpaper = new Wallpaper(this.config.desktop.wallpaper);
    this.syncWallpaperSize();
  }

  /** Mount wallpaper and begin accepting window opens. Idempotent. */
  start(): void {
    this.assertLive();
    if (this.started) return;
    this.scene.add(this.wallpaper);
    this.syncWallpaperSize();
    this.started = true;
    this.scene.markDirty();
  }

  /** Open an app by id (convenience over {@link WindowManager.open}). */
  open(appId: string) {
    this.assertLive();
    if (!this.started) this.start();
    return this.windowManager.open(appId);
  }

  /** Tear down windows, wallpaper, and registry hooks. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.windowManager.closeAll();
    if (this.wallpaper.parent) {
      this.scene.remove(this.wallpaper);
    }
    this.wallpaper.destroy();
    this.started = false;
  }

  private syncWallpaperSize(): void {
    this.wallpaper.width = this.scene.width || 800;
    this.wallpaper.height = this.scene.height || 600;
  }

  private assertLive(): void {
    if (this.disposed) {
      throw new Error('DesktopShell has been disposed');
    }
  }
}

function resolveChrome(config: ResolvedWebosConfig): WindowChrome {
  const t = config.theme;
  const num = (key: string, fallback: number): number => {
    const v = t[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };
  const str = (key: string, fallback: string): string => {
    const v = t[key];
    return typeof v === 'string' ? v : fallback;
  };
  return {
    windowBg: str('desktop-window-bg', '#0f172a'),
    windowBorder: str('desktop-window-border', '#334155'),
    titlebarBg: str('desktop-titlebar-bg', '#1e293b'),
    titlebarFg: str('desktop-titlebar-fg', '#e2e8f0'),
    titlebarHeight: num('desktop-titlebar-height', 32),
    closeBg: str('desktop-close-bg', '#334155'),
    closeFg: str('desktop-close-fg', '#e2e8f0'),
    focusRing: str('desktop-focus-ring', '#38bdf8'),
    radius: num('desktop-radius', 10),
  };
}
