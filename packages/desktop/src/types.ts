import type { Entity, Scene } from '@vectojs/core';
import type { ThemeTokenSet } from '@vectojs/styles';

/** Flat theme tokens for the desktop shell (no `--` prefix). */
export type DesktopThemeTokens = ThemeTokenSet;

/** One installable application. */
export interface AppDefinition {
  /** Stable id used by config, shortcuts, and {@link AppRegistry}. */
  id: string;
  /** Human-readable title (window chrome, launchers). */
  title: string;
  /** Optional icon glyph or short label for future taskbar use. */
  icon?: string;
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
  /** Close the hosting window (if still open). */
  close: () => void;
}

/** Desktop surface options. */
export interface DesktopConfig {
  /** Wallpaper fill. Default uses `var(--desktop-wallpaper)`. */
  wallpaper?: string;
  /** Logical width hint; the shell follows the scene size at runtime. */
  width?: number;
  /** Logical height hint. */
  height?: number;
}

/** Keyboard shortcut → app id (Phase 1 stores only; no global key router yet). */
export type ShortcutMap = Record<string, string>;

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
  /** Optional shortcut table (reserved for a later input router). */
  shortcuts?: ShortcutMap;
}

/** Resolved, validated config with defaults applied. */
export interface ResolvedWebosConfig {
  desktop: Required<Pick<DesktopConfig, 'wallpaper'>> & DesktopConfig;
  theme: DesktopThemeTokens;
  apps: AppDefinition[];
  shortcuts: ShortcutMap;
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
};
