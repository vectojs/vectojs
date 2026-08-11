import type { ThemeTokenSet } from './theme';

/**
 * Ready-made token sets. Each is a flat {@link ThemeTokenSet} — pass it to
 * `tokens(...)` and `setTheme(...)`:
 *
 * ```ts
 * import { tokens, setTheme, PRESET_THEMES } from '@vectojs/styles';
 * setTheme(tokens(PRESET_THEMES.dark));
 * ```
 */
export const PRESET_THEMES: Record<'light' | 'dark' | 'github' | 'dracula', ThemeTokenSet> = {
  light: {
    accent: '#2563eb',
    surface: '#ffffff',
    surfaceAlt: '#f6f8fa',
    text: '#1f2328',
    muted: '#6e7781',
    border: '#d0d7de',
    'radius-sm': 4,
    'radius-md': 8,
    'radius-lg': 12,
    font: '16px Inter',
    fontMono: '13px ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  dark: {
    accent: '#58a6ff',
    surface: '#0d1117',
    surfaceAlt: '#161b22',
    text: '#e6edf3',
    muted: '#8b949e',
    border: '#30363d',
    'radius-sm': 4,
    'radius-md': 8,
    'radius-lg': 12,
    font: '16px Inter',
    fontMono: '13px ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  github: {
    accent: '#0969da',
    surface: '#ffffff',
    surfaceAlt: '#f6f8fa',
    text: '#1f2328',
    muted: '#59636e',
    border: '#d1d9e0',
    'radius-sm': 4,
    'radius-md': 8,
    'radius-lg': 12,
    font: '16px Inter',
    fontMono: '13px ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  dracula: {
    accent: '#bd93f9',
    surface: '#282a36',
    surfaceAlt: '#44475a',
    text: '#f8f8f2',
    muted: '#6272a4',
    border: '#44475a',
    'radius-sm': 4,
    'radius-md': 8,
    'radius-lg': 12,
    font: '16px Inter',
    fontMono: '13px ui-monospace, SFMono-Regular, Menlo, monospace',
  },
};
