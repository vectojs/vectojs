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
 * ordinary spreads. String values may reference tokens from the active theme
 * via `var(--<key>)` (see {@link setTheme}).
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
  /** Inner padding: a single value, or per-axis `{ x, y }` (0.2.0+). */
  padding?: CssLength | { x?: CssLength; y?: CssLength };
  // ── Text (Text, RichText, …) ─────────────────────────────────────────────
  /** Full CSS font shorthand as a string, e.g. `'16px Inter'`. */
  font?: string;
  /** Font family — composed into the entity's `font` string (0.2.0+). */
  fontFamily?: string;
  /** Font size in px — composed into the entity's `font` string (0.2.0+). */
  fontSize?: CssLength;
  /** Font weight — composed into the entity's `font` string (0.2.0+). */
  fontWeight?: number | 'normal' | 'bold' | 'bolder' | 'lighter';
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

/** What {@link applyStyle} actually wrote, keyed by CSS property name. */
export interface AppliedStyle {
  applied: string[];
}
