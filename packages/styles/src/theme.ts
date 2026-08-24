import type { Entity } from '@vectojs/core';
import { PRESET_THEMES } from './presets';
import type { Style } from './types';

/** A `var(--key)` reference with the key in capture group 1. Shared with the apply layer. */
export const VAR_RE = /^var\(--([\w-]+)\)$/;

/** An embedded `var(--key)` reference anywhere inside a composite string
 *  (e.g. `'rgba(var(--rgb), 0.4)'`). Shared with the apply layer, which also
 *  derives its global replace form from it. */
export const HAS_VAR_RE = /var\(--([\w-]+)\)/;

/** A `var(--key, fallback)` reference — the CSS fallback form. Neither
 *  {@link VAR_RE} nor {@link HAS_VAR_RE} matches it (`\)` must follow the key),
 *  so pre-#645 it passed through unresolved: the raw string reached mapped
 *  fields where Canvas2D silently kept the previous paint, and the key went
 *  untracked for theme switches. Detected explicitly so the apply layer can
 *  fail loudly instead — fallback resolution is not implemented, and silence
 *  is the one thing this package must never do with an unrecognized `var()`
 *  form (the GH-608 doctrine). */
export const HAS_VAR_FALLBACK_RE = /var\(--[\w-]+\s*,/;

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
 * being clobbered by it on the next switch.
 *
 * Entities are held through {@link WeakRef}s, not strongly: `Entity.destroy()`
 * has no hook back into this package, so a strong inner map retained every
 * styled entity for the lifetime of its theme and `setTheme` kept re-resolving
 * destroyed ones (#644). Dead refs are swept during that walk; callers that
 * know an entity is gone can release it eagerly with {@link untrackVarStyles}.
 * The theme side stays a WeakMap: a dropped theme is collected wholesale.
 */
const varPairs = new WeakMap<Theme, Map<WeakRef<Entity>, Map<string, unknown>>>();

/** Stable {@link WeakRef} per entity, so repeated styles on one entity hit the
 *  same tracking entry instead of orphaning unreachable duplicates. Weakly
 *  held itself: the ref object dies with the entity. */
const entityRefs = new WeakMap<Entity, WeakRef<Entity>>();

const refOf = (entity: Entity): WeakRef<Entity> => {
  let ref = entityRefs.get(entity);
  if (!ref) {
    ref = new WeakRef(entity);
    entityRefs.set(entity, ref);
  }
  return ref;
};

const pairsOf = (theme: Theme): Map<WeakRef<Entity>, Map<string, unknown>> => {
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
 * The switch is atomic with respect to token resolution: every tracked style
 * is resolved against `next` *before* the active theme changes, so a theme
 * that is missing a referenced token throws while the scene, the active theme
 * and the pair bookkeeping are all still fully consistent under the previous
 * theme — never half-restyled.
 *
 * Throws if a token value does not survive the mapped property's validation
 * (e.g. `--gap: '50%'`), so a broken theme fails loudly on switch.
 */
export function setTheme(next: Theme): void {
  if (next === current.theme) return;
  const previous = current.theme;
  const pairs = varPairs.get(previous);
  // Dry-run: resolve every tracked style against `next` first. A missing token
  // throws here, before `current.theme` moves or any entity is touched.
  // Entries whose entity is already collected are swept on the way (#644) —
  // they can neither be re-resolved nor released by any destroy hook.
  const resolved = new Map<WeakRef<Entity>, Style>();
  if (pairs) {
    for (const [ref, keys] of pairs) {
      const entity = ref.deref();
      if (entity === undefined) {
        pairs.delete(ref);
        continue;
      }
      const style: Style = {};
      for (const [key, expr] of keys) {
        (style as Record<string, unknown>)[key] = expr;
      }
      resolved.set(ref, resolveStyle(style, next).style);
    }
  }
  current.theme = next;
  if (pairs) {
    const nextPairs = pairsOf(next);
    for (const [ref, style] of resolved) {
      const entity = ref.deref();
      if (entity === undefined) continue; // collected between the passes
      applyStyleResolved(entity, style);
      nextPairs.set(ref, pairs.get(ref)!);
    }
    varPairs.delete(previous);
  }
}

/**
 * Drop every var() reference tracked for `entity` under the active theme, so
 * {@link setTheme} stops re-resolving its styles. `Entity.destroy()` cannot
 * call this (core has no dependency on styles), so tracking also releases the
 * entity weakly and sweeps collected entries on switch — this is the eager,
 * deterministic path for frameworks that do know when an entity is gone.
 * Idempotent; safe for entities that never had a tracked style.
 */
export function untrackVarStyles(entity: Entity): void {
  varPairs.get(current.theme)?.delete(refOf(entity));
}

/**
 * Register the var()-referencing keys of a style under the active theme.
 * Called by {@link applyStyle}; not part of the public surface.
 *
 * - A key whose value references a `var(--…)` token — anchored or embedded in
 *   a composite string — is tracked.
 * - A key whose value is a literal (or no longer references a token) stops
 *   being tracked — the literal is written by the caller and must not be
 *   re-resolved (and possibly clobbered) on the next theme switch.
 * - `padding` objects track as a whole when either axis references a token.
 */
export function trackVarKeys(entity: Entity, style: Style): void {
  const pairs = pairsOf(current.theme);
  const ref = refOf(entity);
  const keys = pairs.get(ref) ?? new Map<string, unknown>();
  for (const [key, value] of Object.entries(style)) {
    if (value === undefined) continue;
    if (typeof value === 'string' && HAS_VAR_RE.test(value)) {
      keys.set(key, value);
      continue;
    }
    if (key === 'padding' && typeof value === 'object' && value !== null) {
      const pad = value as { x?: unknown; y?: unknown };
      const referencesToken =
        (typeof pad.x === 'string' && HAS_VAR_RE.test(pad.x)) ||
        (typeof pad.y === 'string' && HAS_VAR_RE.test(pad.y));
      if (referencesToken) {
        keys.set(key, value);
        continue;
      }
    }
    keys.delete(key);
  }
  if (keys.size === 0) pairs.delete(ref);
  else pairs.set(ref, keys);
}

// Re-exported for the apply layer without an import cycle.
import { applyStyleResolved, resolveStyle } from './apply';
export type { Style };
