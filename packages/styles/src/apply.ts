import type { Entity } from '@vectojs/core';
import { composeFont } from './font';
import {
  getTheme,
  HAS_VAR_FALLBACK_RE,
  HAS_VAR_RE,
  trackVarKeys,
  VAR_RE,
  type Theme,
} from './theme';
import type { AppliedStyle, CssLength, Style } from './types';

type ValueOf<T> = T[keyof T];

interface Rule {
  /** Entity field to write; `null` means validation-only (e.g. `display`). */
  field: string | null;
  /** True when the key only makes sense on a container (Stack/Flow). */
  containerOnly: boolean;
  convert: (value: ValueOf<Style>, key: string) => number | string | boolean;
}

const isCssLength = (value: unknown, key: string): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^[+-]?(\d+\.?\d*|\.\d+)px$/.test(value)) {
    return Number.parseFloat(value);
  }
  throw new TypeError(
    `@vectojs/styles: ${key} expects a bare number or a px string (got ${JSON.stringify(value)})`,
  );
};

const isFiniteNumber = (value: unknown, key: string): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new TypeError(`@vectojs/styles: ${key} expects a number (got ${JSON.stringify(value)})`);
};

const isString = (value: unknown, key: string): string => {
  if (typeof value === 'string') return value;
  throw new TypeError(`@vectojs/styles: ${key} expects a string (got ${JSON.stringify(value)})`);
};

const oneOf =
  <T extends string>(allowed: readonly T[]) =>
  (value: unknown, key: string): T => {
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
      return value as T;
    }
    throw new TypeError(
      `@vectojs/styles: ${key} expects one of ${allowed.join(' | ')} (got ${JSON.stringify(value)})`,
    );
  };

const RULES: Record<string, Rule> = {
  x: { field: 'x', containerOnly: false, convert: isCssLength },
  y: { field: 'y', containerOnly: false, convert: isCssLength },
  width: { field: 'width', containerOnly: false, convert: isCssLength },
  height: { field: 'height', containerOnly: false, convert: isCssLength },
  scaleX: { field: 'scaleX', containerOnly: false, convert: isFiniteNumber },
  scaleY: { field: 'scaleY', containerOnly: false, convert: isFiniteNumber },
  rotation: { field: 'rotation', containerOnly: false, convert: isFiniteNumber },
  opacity: { field: 'opacity', containerOnly: false, convert: isFiniteNumber },
  backgroundColor: { field: 'bg', containerOnly: false, convert: isString },
  color: { field: 'color', containerOnly: false, convert: isString },
  borderColor: { field: 'borderColor', containerOnly: false, convert: isString },
  borderRadius: { field: 'radius', containerOnly: false, convert: isCssLength },
  padding: { field: 'padding', containerOnly: false, convert: isCssLength },
  font: { field: 'font', containerOnly: false, convert: isString },
  lineHeight: { field: 'lineHeight', containerOnly: false, convert: isCssLength },
  textAlign: { field: 'textAlign', containerOnly: false, convert: oneOf(['left', 'justify']) },
  display: {
    field: null,
    containerOnly: true,
    convert: (value) => oneOf(['flex'] as const)(value, 'display'),
  },
  flexDirection: {
    field: 'direction',
    containerOnly: true,
    convert: (value, key) =>
      (({ row: 'horizontal', column: 'vertical' }) as const)[
        oneOf(['row', 'column'] as const)(value, key)
      ],
  },
  gap: { field: 'gap', containerOnly: true, convert: isCssLength },
  alignItems: {
    field: 'align',
    containerOnly: true,
    convert: (value, key) =>
      (({ 'flex-start': 'start', 'flex-end': 'end', center: 'center' }) as const)[
        oneOf(['flex-start', 'center', 'flex-end'] as const)(value, key)
      ],
  },
  flexWrap: {
    field: 'wrap',
    containerOnly: true,
    convert: (value, key) => oneOf(['wrap', 'nowrap'] as const)(value, key) === 'wrap',
  },
};

/** Font shorthand segments, special-cased in the apply loop. */
const FONT_KEYS = ['fontFamily', 'fontSize', 'fontWeight'] as const;

/** Global form of {@link HAS_VAR_RE} for substituting every embedded
 *  `var(--…)` occurrence in one composite string. */
const VAR_REPLACE_RE = /var\(--([\w-]+)\)/g;

/** Resolve a single `var(--key)` reference to its token value, following
 *  chains of token-references-token transitively. `seen` carries the keys of
 *  the resolution path so far: a key re-entering its own path is a cycle and
 *  fails loudly with the chain. The key is removed again once its subtree has
 *  resolved, so sibling references to the same token are independent. */
function resolveToken(key: string, theme: Theme, seen: Set<string>): unknown {
  const token = theme.tokens[key];
  if (token === undefined) {
    throw new TypeError(
      `@vectojs/styles: unknown token 'var(--${key})' — not present in the active theme`,
    );
  }
  if (seen.has(key)) {
    const chain = [...seen, key].map((k) => `var(--${k})`).join(' → ');
    throw new TypeError(`@vectojs/styles: circular var() reference: ${chain}`);
  }
  seen.add(key);
  try {
    return resolveValue(token, theme, seen);
  } finally {
    seen.delete(key);
  }
}

/** Resolve a single value against the theme; non-`var()` values pass through. *  A value that is exactly a `var(--key)` reference resolves to the token's
 *  own value (a number stays a number). A composite string with `var()`
 *  embedded somewhere (e.g. `'rgba(var(--rgb), 0.4)'`) resolves every
 *  occurrence by substituting the stringified token values — leaving such a
 *  string unresolved used to write literal garbage to the entity field while
 *  Canvas2D silently kept the old value (GH-608). */
function resolveValue(value: unknown, theme: Theme, seen: Set<string> = new Set()): unknown {
  if (typeof value !== 'string') return value;
  const match = VAR_RE.exec(value);
  if (match) return resolveToken(match[1] ?? '', theme, seen);
  // The fallback form matched neither VAR_RE nor HAS_VAR_RE (#645): without
  // this guard the raw string reached mapped fields, where Canvas2D silently
  // kept the previous paint, and the key went untracked for theme switches.
  // Fail loudly instead — also covers fallbacks arriving through a token,
  // because token resolution recurses back into resolveValue. Runs before the
  // embedded-substitution path so composite strings are covered too.
  if (HAS_VAR_FALLBACK_RE.test(value)) {
    throw new TypeError(
      `@vectojs/styles: var() fallbacks are not supported — '${value}' would reach the entity field unresolved; set the token in the active theme or pass the literal`,
    );
  }
  if (!HAS_VAR_RE.test(value)) return value;
  // Reset lastIndex defensively even though VAR_REPLACE_RE is module-local and
  // replace() always runs it to completion from zero.
  VAR_REPLACE_RE.lastIndex = 0;
  return value.replace(VAR_REPLACE_RE, (_whole: string, key: string) =>
    String(resolveToken(key, theme, seen)),
  );
}

/** Resolve `var()` references in a style object, in place of the caller's object. */
export function resolveStyle(style: Style, theme: Theme): { style: Style; hadVar: boolean } {
  let hadVar = false;
  const out: Style = {};
  for (const [key, value] of Object.entries(style)) {
    if (value === undefined) continue;
    if (key === 'padding' && typeof value === 'object' && value !== null) {
      const pad = value as { x?: CssLength; y?: CssLength };
      const x = resolveValue(pad.x, theme);
      const y = resolveValue(pad.y, theme);
      out.padding = { x: x as CssLength | undefined, y: y as CssLength | undefined };
      hadVar ||= x !== pad.x || y !== pad.y;
      continue;
    }
    const resolved = resolveValue(value, theme);
    hadVar ||= resolved !== value;
    (out as Record<string, unknown>)[key] = resolved;
  }
  return { style: out, hadVar };
}

/** Apply a resolved style without a theme lookup; internal for {@link setTheme}. */
export function applyStyleResolved(entity: Entity, style: Style): AppliedStyle {
  const applied: string[] = [];
  const fontChanges: { fontFamily?: string; fontSize?: string; fontWeight?: string } = {};
  let fontTouched = false;

  const write = (key: string, field: string | null, converted: unknown, containerOnly: boolean) => {
    if (field !== null && !(field in entity)) {
      if (containerOnly) {
        throw new TypeError(
          `@vectojs/styles: '${key}' is a container-only property and ${entity.constructor.name} is not a container`,
        );
      }
      return false;
    }
    if (containerOnly && field === null && !('direction' in entity)) {
      throw new TypeError(
        `@vectojs/styles: '${key}' is a container-only property and ${entity.constructor.name} is not a container`,
      );
    }
    if (field !== null) {
      (entity as unknown as Record<string, unknown>)[field] = converted;
    }
    return true;
  };

  for (const [key, value] of Object.entries(style)) {
    if (value === undefined) continue;
    if ((FONT_KEYS as readonly string[]).includes(key)) {
      const field = 'font';
      if (!(field in entity)) continue;
      fontTouched = true;
      if (key === 'fontFamily') {
        if (typeof value === 'string' && /\d/.test(value)) {
          throw new TypeError(
            `@vectojs/styles: fontFamily resolved to '${value}' which looks like a font shorthand — ` +
              `reference the 'font' token (full shorthand) or a family-only token instead`,
          );
        }
        fontChanges.fontFamily = value as string;
      }
      if (key === 'fontSize') {
        if (typeof value === 'number') {
          throw new TypeError(
            `@vectojs/styles: fontSize resolved to the bare number ${value} — ` +
              `use a unit-bearing token (e.g. '16px') so the composed font string stays valid`,
          );
        }
        const size = String(value);
        // The Style type narrows fontSize to `${number}px`; JS callers and
        // token values bypass the type, so enforce it at runtime too — '2em'
        // used to compose a shorthand Canvas2D silently drops (GH-608).
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)px$/.test(size)) {
          throw new TypeError(
            `@vectojs/styles: fontSize expects a px string like '16px' (got ${JSON.stringify(size)})`,
          );
        }
        fontChanges.fontSize = size;
      }
      if (key === 'fontWeight') fontChanges.fontWeight = String(value);
      applied.push(key);
      continue;
    }
    if (key === 'padding' && typeof value === 'object' && value !== null) {
      const pad = value as { x?: number | string; y?: number | string };
      let wrote = false;
      for (const axis of ['x', 'y'] as const) {
        const v = pad[axis];
        if (v === undefined) continue;
        const field = axis === 'x' ? 'paddingX' : 'paddingY';
        if (!(field in entity)) continue;
        (entity as unknown as Record<string, unknown>)[field] = isCssLength(v, `padding.${axis}`);
        wrote = true;
      }
      if (wrote) applied.push(key);
      continue;
    }
    const rule = RULES[key];
    if (!rule) {
      throw new TypeError(`@vectojs/styles: unknown style property '${key}'`);
    }
    if (write(key, rule.field, rule.convert(value, key), rule.containerOnly)) {
      applied.push(key);
    }
  }

  if (fontTouched && 'font' in entity) {
    const current = String((entity as unknown as Record<string, unknown>).font ?? '');
    (entity as unknown as Record<string, unknown>).font = composeFont(current, fontChanges);
  }

  if (applied.length > 0) {
    entity.scene?.markDirty();
  }
  return { applied };
}

/**
 * Apply a CSS-named style object onto an entity by writing the mapped fields.
 *
 * - String values of the form `var(--key)` are resolved against the active
 *   theme (see {@link setTheme}); styles that reference tokens are tracked and
 *   re-applied when the theme switches.
 * - Keys whose field does not exist on the entity are skipped silently, so one
 *   style object can be shared across components that accept different keys.
 * - Layout keys (`display`, `flexDirection`, `gap`, `alignItems`, `flexWrap`)
 *   on an entity that is not a container throw — that is a category error,
 *   not a no-op.
 * - Invalid values (`'50%'`, `'8em'`, `textAlign: 'center'`) throw with the
 *   property name, so migrating CSS does not fail silently.
 * - Calls `entity.scene.markDirty()` once when at least one key was written,
 *   honouring the onDemand render-mode contract.
 *
 * @returns The CSS property names that were written, in object order.
 */
export function applyStyle(entity: Entity, s: Style): AppliedStyle {
  const { style: resolved } = resolveStyle(s, getTheme());
  const result = applyStyleResolved(entity, resolved);
  // Always sync tracking: var() values register their keys, and literal values
  // on the same key stop tracking (they must not be replayed on a theme
  // switch). trackVarKeys is a no-op for keys absent from the style.
  trackVarKeys(entity, s);
  return result;
}
