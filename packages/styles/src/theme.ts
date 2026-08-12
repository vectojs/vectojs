import type { Entity } from '@vectojs/core';
import { PRESET_THEMES } from './presets';
import type { Style } from './types';

/** A `var(--key)` reference with the key in capture group 1. Shared with the apply layer. */
export const VAR_RE = /^var\(--([\w-]+)\)$/;

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
 * Per-entity var() references, keyed by the theme they were applied under, so
 * {@link setTheme} can re-resolve and re-write them. Each entity maps its
 * tracked style *keys* to the var expression they reference — not the whole
 * style object — so multiple var-referencing styles on one entity accumulate,
 * and a later literal value on the same key replaces the reference instead of
 * being clobbered by it on the next switch. WeakMap on both sides: a destroyed
 * entity or a dropped theme is collected.
 */
const varPairs = new WeakMap<Theme, Map<Entity, Map<string, unknown>>>();

const pairsOf = (theme: Theme): Map<Entity, Map<string, unknown>> => {
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
    for (const [entity, keys] of pairs) {
      const style: Style = {};
      for (const [key, expr] of keys) {
        (style as Record<string, unknown>)[key] = expr;
      }
      reapplyStyle(entity, style, next);
      nextPairs.set(entity, keys);
    }
    varPairs.delete(previous);
  }
}

/**
 * Register the var()-referencing keys of a style under the active theme.
 * Called by {@link applyStyle}; not part of the public surface.
 *
 * - A key whose value is a `var(--…)` expression is tracked.
 * - A key whose value is a literal (or no longer references a token) stops
 *   being tracked — the literal is written by the caller and must not be
 *   re-resolved (and possibly clobbered) on the next theme switch.
 * - `padding` objects track as a whole when either axis references a token.
 */
export function trackVarKeys(entity: Entity, style: Style): void {
  const pairs = pairsOf(current.theme);
  const keys = pairs.get(entity) ?? new Map<string, unknown>();
  for (const [key, value] of Object.entries(style)) {
    if (value === undefined) continue;
    if (typeof value === 'string' && VAR_RE.test(value)) {
      keys.set(key, value);
      continue;
    }
    if (key === 'padding' && typeof value === 'object' && value !== null) {
      const pad = value as { x?: unknown; y?: unknown };
      const referencesToken =
        (typeof pad.x === 'string' && VAR_RE.test(pad.x)) ||
        (typeof pad.y === 'string' && VAR_RE.test(pad.y));
      if (referencesToken) {
        keys.set(key, value);
        continue;
      }
    }
    keys.delete(key);
  }
  if (keys.size === 0) pairs.delete(entity);
  else pairs.set(entity, keys);
}

// Re-exported for the apply layer without an import cycle.
import { reapplyStyle } from './apply';
export type { Style };
