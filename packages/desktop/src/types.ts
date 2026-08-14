import type { Entity, Scene } from '@vectojs/core';
import type { ThemeTokenSet } from '@vectojs/styles';
import type { Vfs } from './Vfs';

/** Flat theme tokens for the desktop shell (no `--` prefix). */
export type DesktopThemeTokens = ThemeTokenSet;

/** How many concurrent windows an app may open. */
export type WindowInstancePolicy = 'single' | 'multiple';

/** One installable application. */
export interface AppDefinition {
  /** Stable id used by config, shortcuts, and {@link AppRegistry}. */
  id: string;
  /** Human-readable title (window chrome, launchers). */
  title: string;
  /** Optional short glyph/label for the taskbar pin. */
  icon?: string;
  /**
   * Window multiplicity. Default `'single'`: a second open focuses the
   * existing window. `'multiple'` always spawns a new window.
   */
  instances?: WindowInstancePolicy;
  /**
   * Build the window client content. Called once per open; the returned entity
   * is parented under the window client area and destroyed with the window.
   */
  create: (ctx: AppContext) => Entity;
}

/** Context handed to {@link AppDefinition.create}. */
export interface AppContext {
  scene: Scene;
  appId: string;
  /** Window instance id (unique per open). */
  windowId: string;
  /** Optional VFS handle when the shell was configured with one. */
  vfs: Vfs | null;
  /** Close the hosting window (if still open). */
  close: () => void;
}

/** One logical display rectangle inside the single Scene canvas. */
export interface DisplaySpec {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Desktop surface options. */
export interface DesktopConfig {
  /** Solid wallpaper fill when no image is set. */
  wallpaper?: string;
  /** Optional image URL drawn cover-style over the fill. */
  wallpaperImage?: string;
  /** Logical displays. Default: one display covering the scene. */
  displays?: DisplaySpec[];
  /** Taskbar height in px. Default 40. Set 0 to hide. */
  taskbarHeight?: number;
  /** Taskbar edge. Default `'bottom'`. */
  taskbarPosition?: 'bottom' | 'top';
}

/** Keyboard shortcut chord → action. */
export type ShortcutMap = Record<string, ShortcutAction>;

/** Resolved shortcut target. */
export type ShortcutAction =
  | { type: 'open-app'; appId: string }
  | { type: 'close-focused' }
  | { type: 'toggle-start' }
  | { type: 'custom'; id: string };

/**
 * Schema-driven WebOS config. Every customizable surface goes through this
 * object — never hardcode chrome colours or app lists in the window manager.
 */
export interface WebosConfig {
  desktop?: DesktopConfig;
  /** Token set merged over the styles default theme. */
  theme?: DesktopThemeTokens;
  /** Apps available to open by id. */
  apps?: AppDefinition[];
  /**
   * Shortcut table. Keys are normalized chords like `Control+n`, `Meta+w`,
   * `Alt+Tab` (see {@link normalizeChord}).
   */
  shortcuts?: ShortcutMap;
  /** Optional virtual filesystem root. */
  vfs?: Vfs;
}

/** Resolved, validated config with defaults applied. */
export interface ResolvedWebosConfig {
  desktop: {
    wallpaper: string;
    wallpaperImage: string | null;
    displays: DisplaySpec[];
    taskbarHeight: number;
    taskbarPosition: 'bottom' | 'top';
  };
  theme: DesktopThemeTokens;
  apps: AppDefinition[];
  shortcuts: ShortcutMap;
  vfs: Vfs | null;
}

/** Default desktop tokens (flat keys, referenced as `var(--key)`). */
export const DEFAULT_DESKTOP_TOKENS: DesktopThemeTokens = {
  'desktop-wallpaper': '#0b1220',
  'desktop-window-bg': '#0f172a',
  'desktop-window-border': '#334155',
  'desktop-titlebar-bg': '#1e293b',
  'desktop-titlebar-fg': '#e2e8f0',
  'desktop-titlebar-height': 32,
  'desktop-close-bg': '#334155',
  'desktop-close-fg': '#e2e8f0',
  'desktop-focus-ring': '#38bdf8',
  'desktop-radius': 10,
  'desktop-taskbar-bg': '#0f172a',
  'desktop-taskbar-fg': '#e2e8f0',
  'desktop-taskbar-hover': '#1e293b',
  'desktop-taskbar-active': '#1d4ed8',
  'desktop-start-bg': '#1e293b',
  'desktop-start-border': '#334155',
  'desktop-resize-handle': 6,
  'desktop-min-width': 200,
  'desktop-min-height': 120,
};
