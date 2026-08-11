import type { Entity } from '@vectojs/core';

/** A length in CSS: a bare number (treated as px) or a `px` string. */
export type CssLength = number | `${number}px`;

/**
 * A style object written with CSS property names and CSS-like values.
 *
 * Deliberately **not** a CSS parser: values are typed here, converted by a
 * fixed lookup table in {@link applyStyle}, and mapped onto numeric entity
 * fields. There is no cascade, no selector, no inheritance — the numeric
 * Virtual Math Tree stays the single source of truth.
 *
 * Every key is optional and a style object is a plain object, so themes are
 * ordinary spreads: `{ ...base, ...variant }`.
 */
export interface Style {
  // ── Geometry (any entity) ────────────────────────────────────────────────
  x?: CssLength;
  y?: CssLength;
  width?: CssLength;
  height?: CssLength;
  scaleX?: number;
  scaleY?: number;
  /** Rotation in radians (VectoJS convention, not CSS degrees). */
  rotation?: number;
  opacity?: number;
  // ── Box (box-style components: Button, Link, …) ──────────────────────────
  backgroundColor?: string;
  color?: string;
  borderColor?: string;
  /** Corner radius in px. */
  borderRadius?: CssLength;
  /** Inner padding in px (single value; VectoJS has no per-side padding). */
  padding?: CssLength;
  // ── Text (Text, RichText, …) ─────────────────────────────────────────────
  /** Full CSS font shorthand as a string, e.g. `'16px Inter'`. */
  font?: string;
  /** Line height in px. */
  lineHeight?: CssLength;
  /**
   * Horizontal alignment. VectoJS ui text supports `left` and `justify`
   * only — `center`/`right` are rejected by {@link applyStyle}, loudly.
   */
  textAlign?: 'left' | 'justify';
  // ── Layout (containers only: Stack, Flow, …) ─────────────────────────────
  /**
   * Container marker. Only `'flex'` is accepted; it carries no field — a
   * Stack/Flow already *is* a flex container — but it validates that the
   * entity is one, so a mistyped container style fails loudly.
   */
  display?: 'flex';
  /** `'row'` → horizontal, `'column'` → vertical. */
  flexDirection?: 'row' | 'column';
  gap?: CssLength;
  alignItems?: 'flex-start' | 'center' | 'flex-end';
  flexWrap?: 'wrap' | 'nowrap';
}

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

/** What {@link applyStyle} actually wrote, keyed by CSS property name. */
export interface AppliedStyle {
  applied: string[];
}

/** Identity factory: returns the style object unchanged, typed as {@link Style}. */
export function style<T extends Style>(s: T): T {
  return s;
}

/**
 * Apply a CSS-named style object onto an entity by writing the mapped fields.
 *
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
  const applied: string[] = [];
  for (const [key, value] of Object.entries(s)) {
    if (value === undefined) continue;
    const rule = RULES[key];
    if (!rule) {
      throw new TypeError(`@vectojs/styles: unknown style property '${key}'`);
    }
    const field = rule.field;
    if (field !== null && !(field in entity)) {
      if (rule.containerOnly) {
        throw new TypeError(
          `@vectojs/styles: '${key}' is a container-only property and ${entity.constructor.name} is not a container`,
        );
      }
      continue; // not this component's key
    }
    if (rule.containerOnly && field === null && !('direction' in entity)) {
      throw new TypeError(
        `@vectojs/styles: '${key}' is a container-only property and ${entity.constructor.name} is not a container`,
      );
    }
    const converted = rule.convert(value, key);
    if (field !== null) {
      (entity as unknown as Record<string, unknown>)[field] = converted;
    }
    applied.push(key);
  }
  if (applied.length > 0) {
    entity.scene?.markDirty();
  }
  return { applied };
}
