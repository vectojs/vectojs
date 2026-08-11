import type { Entity } from '@vectojs/core';
import { PRESET_THEMES } from './presets';
import type { Style } from './types';

/**
 * A flat token set. Keys are written WITHOUT the `--` prefix and referenced in
 * style objects as `var(--<key>)`, mirroring CSS custom properties:
 *
 * ```ts
 * const theme = tokens({ accent: '#2563eb', 'radius-md': 8 });
 * applyStyle(btn, style({ backgroundColor: 'var(--accent)', borderRadius: 'var(--radius-md)' }));
 * ```
 *
 * Flat by design, like `MarkdownTheme`: single spread, no deep merge, no
 * nesting. Values are strings (passed through to entity fields) or numbers.
 */
export type ThemeTokenSet = Record<string, string | number>;

/** An immutable token collection. Created with {@link tokens}. */
export interface Theme {
  readonly tokens: ThemeTokenSet;
}

/** Create a theme from a flat token set. */
export function tokens(set: ThemeTokenSet): Theme {
  return { tokens: set };
}

/** The theme `var(--…)` references resolve against when none is given. */
export const DEFAULT_THEME: Theme = tokens(PRESET_THEMES.light);

const current = { theme: DEFAULT_THEME };

/**
 * Pairs that carry `var(--…)` references, keyed by the theme they were
 * applied under, so {@link setTheme} can re-resolve and re-write them.
 * WeakMap on both sides: a destroyed entity or a dropped theme is collected.
 */
const varPairs = new WeakMap<Theme, Map<Entity, Style>>();

const pairsOf = (theme: Theme): Map<Entity, Style> => {
  let pairs = varPairs.get(theme);
  if (!pairs) {
    pairs = new Map();
    varPairs.set(theme, pairs);
  }
  return pairs;
};

/** The theme `var(--…)` references currently resolve against. */
export function getTheme(): Theme {
  return current.theme;
}

/**
 * Switch the active theme and re-resolve every style that references `var()`.
 * Pairs registered under the old theme are re-applied under the new one with
 * the new token values, so a theme swap recolours the whole scene with no
 * caller-side changes. Styles without `var()` references are not tracked and
 * are unaffected.
 *
 * Throws if a token value does not survive the mapped property's validation
 * (e.g. `--gap: '50%'`), so a broken theme fails loudly on switch.
 */
export function setTheme(next: Theme): void {
  if (next === current.theme) return;
  const previous = current.theme;
  current.theme = next;
  const pairs = varPairs.get(previous);
  if (pairs) {
    const nextPairs = pairsOf(next);
    for (const [entity, style] of pairs) {
      reapplyStyle(entity, style, next);
      nextPairs.set(entity, style);
    }
    varPairs.delete(previous);
  }
}

/**
 * Register a style under the active theme when it references `var()`.
 * Called by {@link applyStyle}; not part of the public surface.
 */
export function trackVarStyle(entity: Entity, style: Style): void {
  pairsOf(current.theme).set(entity, style);
}

// Re-exported for the apply layer without an import cycle.
import { reapplyStyle } from './apply';
export type { Style };
