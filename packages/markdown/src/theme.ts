/**
 * Color, typography and spacing tokens for `@vectojs/markdown`.
 *
 * Split out of `Markdown.ts` so `CodeBlock` and the inline renderer can take a
 * theme without importing the whole component, which would make the module
 * graph cyclic. See `forge/decisions/file-decomposition-2026-08.md`.
 */

/**
 * Color, typography and spacing theme for Markdown rendering.
 *
 * The shape is deliberately **flat**, not a nested token tree. Every key is
 * optional and merged over {@link DEFAULT_THEME} by a single spread, so adding a
 * key is backward compatible and a caller may override exactly one value
 * without restating a group. A nested `{ colors: {...}, spacing: {...} }` shape
 * would need a deep merge and would break every existing caller.
 *
 * Sizes and spacing are **numbers in px**, not CSS strings, because the values
 * are consumed by canvas layout arithmetic rather than by a stylesheet.
 */
export interface MarkdownTheme {
  // ── Colors ────────────────────────────────────────────────────────────────
  /** Body text color. */
  textColor?: string;
  /** Heading text color. */
  headingColor?: string;
  /** Code text color (inline + block). */
  codeColor?: string;
  /** Code block background color. */
  codeBgColor?: string;
  /** Blockquote border/accent color. */
  quoteBorderColor?: string;
  /**
   * Blockquote text color. Defaults to {@link MarkdownTheme.textColor} so
   * blockquote body text matches surrounding prose unless overridden.
   */
  quoteTextColor?: string;
  /** Horizontal-rule color. */
  hrColor?: string;
  /** Table background color. */
  tableBgColor?: string;
  /** Table header background color. */
  tableHeaderBgColor?: string;
  /** Link text color. */
  linkColor?: string;
  /**
   * Color for TeX source shown verbatim when a formula could not be typeset.
   * Deliberately distinct from body text so an untypeset formula is visible as
   * a failure rather than reading as prose.
   */
  mathFallbackColor?: string;

  // ── Syntax highlighting ───────────────────────────────────────────────────
  /** Code-block keyword color. */
  syntaxKeywordColor?: string;
  /** Code-block string-literal color. */
  syntaxStringColor?: string;
  /** Code-block comment color. */
  syntaxCommentColor?: string;
  /** Code-block numeric-literal color. */
  syntaxNumberColor?: string;

  // ── Typography ────────────────────────────────────────────────────────────
  /** Body font. */
  bodyFont?: string;
  /** Monospace font for code. */
  codeFont?: string;
  /** Base font size in px. */
  fontSize?: number;
  /**
   * Font sizes in px for heading depths 1-6. A shorter array is padded by
   * repeating its last entry; depths past the end clamp to the last entry.
   */
  headingSizes?: readonly number[];
  /** Code-block font size in px. */
  codeFontSize?: number;
  /**
   * Table cell font size in px.
   *
   * Left `undefined` by default and **derived** as `fontSize - 2` (clamped to
   * at least 1) rather than defaulted to a literal, because that is how it was
   * hardcoded before it became a key: a caller who raises only `fontSize` must
   * keep getting a proportionally larger table, which a fixed default would
   * silently break.
   */
  tableFontSize?: number;
  /** Code-block line height in px. */
  codeLineHeight?: number;
  /**
   * Line height in px for body text drawn through the plain-`Text` fallback
   * path (an unrecognised block token that still carries `text`).
   */
  bodyLineHeight?: number;

  // ── Spacing ───────────────────────────────────────────────────────────────
  /** Vertical gap in px between top-level blocks. */
  blockGap?: number;
  /** Inner padding in px of a code block. */
  codePadding?: number;
  /** Corner radius in px of a code block. */
  codeRadius?: number;
  /** Vertical gap in px between list items. */
  listGap?: number;
  /** Vertical gap in px between blocks inside one multi-block list item. */
  listItemGap?: number;
  /** Left indent in px of a blockquote's contents. */
  quoteIndent?: number;
  /** Width in px of a blockquote's accent border. */
  quoteBorderWidth?: number;
  /** Vertical gap in px between blocks inside a blockquote. */
  quoteInnerGap?: number;
  /** Corner radius in px of an image. */
  imageRadius?: number;
}

/**
 * Resolved defaults. Every key of {@link MarkdownTheme} has an entry here, so a
 * resolved theme is `Required<MarkdownTheme>` and no consumer needs a fallback.
 *
 * Two entries are placeholders that {@link resolveTheme} overwrites when the
 * caller did not set them: `quoteTextColor` (follows `textColor`) and
 * `tableFontSize` (derived from `fontSize`). They still carry a literal so this
 * object satisfies `Required<MarkdownTheme>`; read {@link resolveTheme} for the
 * value a caller actually gets.
 */
export const DEFAULT_THEME: Required<MarkdownTheme> = {
  textColor: '#e2e8f0',
  headingColor: '#f8fafc',
  codeColor: '#a5f3fc',
  codeBgColor: 'rgba(30, 41, 59, 0.85)',
  quoteBorderColor: '#6366f1',
  quoteTextColor: '#e2e8f0',
  hrColor: 'rgba(148, 163, 184, 0.3)',
  tableBgColor: 'rgba(15, 15, 25, 0.4)',
  tableHeaderBgColor: 'rgba(255, 255, 255, 0.08)',
  linkColor: '#38bdf8',
  mathFallbackColor: '#fcd34d',
  syntaxKeywordColor: '#c084fc',
  syntaxStringColor: '#86efac',
  syntaxCommentColor: '#64748b',
  syntaxNumberColor: '#fbbf24',
  bodyFont: 'Inter, system-ui, sans-serif',
  codeFont: 'ui-monospace, "JetBrains Mono", "Fira Code", monospace',
  fontSize: 16,
  headingSizes: [32, 28, 24, 20, 18, 16],
  codeFontSize: 15,
  tableFontSize: 14,
  codeLineHeight: 24,
  bodyLineHeight: 24,
  blockGap: 16,
  codePadding: 18,
  codeRadius: 8,
  listGap: 6,
  listItemGap: 4,
  quoteIndent: 16,
  quoteBorderWidth: 4,
  quoteInnerGap: 8,
  imageRadius: 8,
};

/**
 * Merge a caller's partial theme over {@link DEFAULT_THEME}.
 *
 * `tableFontSize` is **derived** from the resolved `fontSize` when the caller
 * did not set it explicitly, so raising only `fontSize` still scales tables.
 * A plain spread cannot express that: `DEFAULT_THEME` has to satisfy
 * `Required<MarkdownTheme>`, so its literal would always win over the
 * derivation.
 */
export function resolveTheme(theme?: MarkdownTheme): Required<MarkdownTheme> {
  const merged: Required<MarkdownTheme> = { ...DEFAULT_THEME, ...theme };
  if (theme?.tableFontSize === undefined) {
    merged.tableFontSize = Math.max(1, merged.fontSize - 2);
  }
  // Blockquote text follows body text unless the caller says otherwise, so
  // overriding only `textColor` recolours quotes too. A literal default here
  // would pin quotes to the stock colour and silently ignore that override.
  if (theme?.quoteTextColor === undefined) {
    merged.quoteTextColor = merged.textColor;
  }
  return merged;
}

/**
 * Font size in px for a 1-based heading depth, clamping past the end of
 * `headingSizes` and tolerating a short or empty array.
 *
 * Extracted so the heading renderer and any caller inspecting the scale agree;
 * an inline `sizes[Math.min(depth - 1, 5)]` silently yields `undefined` for a
 * theme that supplied fewer than six sizes.
 */
export function headingSize(theme: Required<MarkdownTheme>, depth: number): number {
  const sizes = theme.headingSizes;
  if (sizes.length === 0) return theme.fontSize;
  const idx = Math.min(Math.max(depth, 1) - 1, sizes.length - 1);
  return sizes[idx] ?? theme.fontSize;
}
