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
   * Color of a footnote reference marker and of the label on its definition.
   *
   * Defaults to {@link MarkdownTheme.linkColor} so a marker reads as a
   * cross-reference in whatever palette the caller supplied, rather than being
   * pinned to the stock accent. Derived in {@link resolveTheme}, so overriding
   * only `linkColor` recolours footnote markers too.
   *
   * A marker is deliberately **not** a link: it carries no `href`, so it is
   * neither underlined nor routed to `onLinkClick`. There is no destination to
   * give it — the definition is a sibling block in the same document, not a URL —
   * and synthesising one (`'#fn-1'`) would hand a consumer's click handler a
   * string it would try to open as a page.
   */
  footnoteColor?: string;
  /**
   * Color for TeX source shown verbatim when a formula could not be typeset.
   * Deliberately distinct from body text so an untypeset formula is visible as
   * a failure rather than reading as prose.
   */
  mathFallbackColor?: string;
  /**
   * Background fill painted behind `==marked==` text (`markdown-it-mark`),
   * consumed as {@link TextStyle.highlightColor}.
   *
   * A fixed default rather than derived from another theme key, unlike
   * {@link footnoteColor}'s link-color derivation: CSS `mark`'s UA-stylesheet
   * default (`background-color: Mark`, a yellow highlight) is not related to
   * any other color in this theme, so there is nothing sensible to derive it
   * from.
   */
  markHighlightColor?: string;
  /**
   * Accent/border color for a `:::kind` container, keyed by the lowercased
   * `kind` word (`:::warning` → `containerColors.warning`).
   *
   * A `Record`, not one flat key per kind, because the vocabulary of kinds is
   * open — `:::caution`, `:::success` and a project's own house style all
   * have to resolve to *something* without a signature change here. Looked up
   * through {@link containerColor} rather than read directly, which is what
   * applies {@link containerDefaultColor} for a kind absent from the map (or
   * for a bare `:::` with no kind at all).
   *
   * The four defaults mirror the common `note`/`tip`/`warning`/`danger`
   * vocabulary of `markdown-it-container`/Docusaurus/mdBook admonitions;
   * `info` aliases `note`'s color, since the two are used interchangeably
   * across those tools and a project picking one is not expressing a second,
   * distinct semantic.
   */
  containerColors?: Readonly<Record<string, string>>;
  /**
   * Accent/border color for a container whose `kind` is absent from
   * {@link containerColors} — including a bare `:::` with no kind at all.
   * Deliberately neutral (slate) rather than an error color: an unrecognised
   * kind is a project's own vocabulary the theme does not know about, not a
   * mistake.
   */
  containerDefaultColor?: string;
  /**
   * Background fill painted behind a `:::` container's full content area,
   * one flat value for every kind rather than a per-kind tint.
   *
   * Real callout components (Docusaurus admonitions, mdBook, GitHub's own
   * `[!NOTE]`) vary the ACCENT (border/label) by kind but keep one neutral
   * background across all of them — the color is what signals severity, and a
   * differently-tinted background per kind would fight the accent bar for
   * that job rather than support it. Translucent so it composites against
   * whatever surface a container is nested in (a container inside a
   * blockquote inside a list), matching {@link codeBgColor}'s and
   * {@link markHighlightColor}'s own translucent-overlay convention.
   */
  containerBgColor?: string;

  // ── Syntax highlighting ───────────────────────────────────────────────────
  /** Code-block keyword color. */
  syntaxKeywordColor?: string;
  /** Code-block string-literal color. */
  syntaxStringColor?: string;
  /** Code-block comment color. */
  syntaxCommentColor?: string;
  /** Code-block numeric-literal color. */
  syntaxNumberColor?: string;
  /**
   * Color of the language name in a code block's header band.
   *
   * Derived from {@link syntaxCommentColor} in {@link resolveTheme} when the
   * caller does not set it. A comment is the one token class already defined as
   * "present but subordinate to the code", which is exactly the label's role, so
   * a theme that tuned its comment color for a given background has already
   * answered this question. A literal default would ignore that and read wrong on
   * every light preset.
   */
  codeLangColor?: string;

  // ── Typography ────────────────────────────────────────────────────────────
  /**
   * Enable `markdown-it`-style typographic substitutions: `--`/`---` to en/em
   * dash, `...` to an ellipsis, `(c)`/`(r)`/`(tm)` to their symbols, `+-` to
   * `±`, and straight quotes to curly ones (intra-run only — see
   * {@link applyTypography}'s doc for why cross-boundary pairing is out of
   * scope).
   *
   * Off by default, matching `markdown-it`'s own `typographer` option: these
   * substitutions rewrite characters the author did not literally type, so
   * applying them unconditionally would silently change a document's source
   * rather than only its rendering.
   */
  typographer?: boolean;
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
   * Font size in px of the language name in a code block's header band.
   *
   * Left `undefined` by default and **derived** as `codeFontSize - 3` (clamped
   * to at least 1), following {@link tableFontSize}'s precedent: the label is
   * chrome around the code, so a caller who raises only `codeFontSize` should
   * get a proportionally larger label rather than one that stays put and
   * gradually looks detached from the block it belongs to.
   */
  codeLangFontSize?: number;
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
  /**
   * Size of a footnote reference marker, as a multiple of the size of the run it
   * sits in.
   *
   * Relative rather than absolute so a marker in a heading scales with the
   * heading, exactly as inline math and inline images do. Smaller than the
   * surrounding prose is the whole visual signal that `[1]` is a reference and
   * not literal text, since {@link TextStyle} has no baseline shift and a raised
   * superscript is therefore not expressible — see `markdown-footnote.ts`.
   */
  footnoteMarkerScale?: number;
  /**
   * Size of a subscript run (`H~2~O`'s `2`), as a multiple of the size of the
   * run it sits in.
   *
   * Mirrors `markdown-it-sub`'s ~0.75em. Relative rather than absolute for the
   * same reason as {@link footnoteMarkerScale}: a subscript inside a heading
   * scales with the heading rather than reserving a body-sized glyph.
   */
  subscriptScale?: number;
  /**
   * Baseline shift for a subscript run, in em of the size of the run it sits
   * in (the *unscaled* surrounding run, matching CSS `vertical-align: sub`,
   * which is relative to the parent's font size rather than the subscript's
   * own reduced one).
   *
   * Sign matches `TextStyle.baselineShift`: negative moves the run down. `-0.15`
   * sits in markdown-it's ~-0.15em to -0.2em range; nothing in that range reaches
   * the line-growth threshold at the default {@link subscriptScale}, so a lone
   * subscript run does not grow its line (see `DEC-0001`'s degenerate case).
   */
  subscriptShift?: number;
  /**
   * Size of a superscript run (`19^th^`'s `th`), as a multiple of the size of
   * the run it sits in. Mirrors `subscriptScale`; see that doc for why relative.
   */
  superscriptScale?: number;
  /**
   * Baseline shift for a superscript run, in em of the size of the run it sits
   * in (the *unscaled* surrounding run — see {@link subscriptShift} for why).
   *
   * Positive, unlike `subscriptShift`: `TextStyle.baselineShift` is positive =
   * up. `0.2` mirrors `subscriptShift`'s magnitude and, measured against
   * `shiftedExtent()` at the default {@link superscriptScale}, is the largest
   * shift that stays inside the line's existing growth slack for a lone raised
   * run (see `DEC-0001`'s degenerate case) — `0.25` and up already force
   * growth at this scale, which was measured directly rather than assumed:
   * an earlier draft of this default (`0.3`, markdown-it's own superscript
   * figure) was picked from that library's CSS without checking it against
   * this engine's `shiftedExtent()` math, and it does force growth here.
   */
  superscriptShift?: number;
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
  /**
   * Left indent in px of a `:::` container's contents, from its accent
   * border. Mirrors {@link quoteIndent} — a container is visually a
   * blockquote with a label and a per-kind color, not a structurally
   * different shape.
   */
  containerIndent?: number;
  /** Width in px of a `:::` container's accent border. Mirrors {@link quoteBorderWidth}. */
  containerBorderWidth?: number;
  /** Vertical gap in px between blocks inside a `:::` container. Mirrors {@link quoteInnerGap}. */
  containerInnerGap?: number;
  /** Corner radius in px of a `:::` container's background fill. */
  containerRadius?: number;
  /** Corner radius in px of an image. */
  imageRadius?: number;
  /**
   * Height of an image that renders *inline*, as a multiple of the run's font
   * size.
   *
   * Applies only where an image shares a line with text — a heading or a table
   * cell. An image that is its own block (the ordinary `![alt](url)` paragraph)
   * still renders at its natural size capped to the available width, and ignores
   * this.
   *
   * A cap rather than the natural size, because an inline object's box is fixed
   * when the span is collected while the natural size is known only after the
   * decode, and because a 512px logo written into an `h1` would otherwise tower
   * over its own heading. The width follows the natural aspect ratio, so a wide
   * badge stays wide. `1.15` keeps a square icon a little shorter than the line it
   * sits on, which is where a cap-height glyph puts its own ink.
   */
  inlineImageScale?: number;
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
  typographer: false,
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
  footnoteColor: '#38bdf8',
  mathFallbackColor: '#fcd34d',
  markHighlightColor: 'rgba(250, 204, 21, 0.35)',
  containerColors: {
    note: '#38bdf8',
    info: '#38bdf8',
    tip: '#4ade80',
    warning: '#fbbf24',
    danger: '#f87171',
    caution: '#f87171',
  },
  containerDefaultColor: '#94a3b8',
  containerBgColor: 'rgba(148, 163, 184, 0.08)',
  syntaxKeywordColor: '#c084fc',
  syntaxStringColor: '#86efac',
  syntaxCommentColor: '#64748b',
  syntaxNumberColor: '#fbbf24',
  codeLangColor: '#64748b',
  bodyFont: 'Inter, system-ui, sans-serif',
  codeFont: 'ui-monospace, "JetBrains Mono", "Fira Code", monospace',
  fontSize: 16,
  headingSizes: [32, 28, 24, 20, 18, 16],
  codeFontSize: 15,
  codeLangFontSize: 12,
  tableFontSize: 14,
  footnoteMarkerScale: 0.75,
  subscriptScale: 0.75,
  subscriptShift: -0.15,
  superscriptScale: 0.75,
  superscriptShift: 0.2,
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
  containerIndent: 16,
  containerBorderWidth: 4,
  containerInnerGap: 8,
  containerRadius: 8,
  imageRadius: 8,
  inlineImageScale: 1.15,
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
  // A footnote marker follows the link colour unless the caller says otherwise,
  // for the same reason: it reads as a cross-reference, so a caller who recoloured
  // links has already expressed what a cross-reference should look like. A literal
  // default would pin markers to the stock accent and silently ignore that.
  if (theme?.footnoteColor === undefined) {
    merged.footnoteColor = merged.linkColor;
  }
  // The code header's language label follows the comment colour, and its size
  // follows the code size, for the reasons given on each key: both are chrome
  // around the code, so a caller who restyled the code has already said what its
  // chrome should look like. Literal defaults would pin the label to the stock
  // dark palette and silently ignore a light preset.
  if (theme?.codeLangColor === undefined) {
    merged.codeLangColor = merged.syntaxCommentColor;
  }
  if (theme?.codeLangFontSize === undefined) {
    merged.codeLangFontSize = Math.max(1, merged.codeFontSize - 3);
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

/**
 * Accent/border color for a `:::kind` container, looked up case-insensitively
 * (`:::Warning` and `:::warning` resolve identically — a container's `kind` is
 * a fixed vocabulary word, not case-sensitive prose) against
 * {@link MarkdownTheme.containerColors}. Falls back to
 * {@link MarkdownTheme.containerDefaultColor} for a kind the map does not
 * carry, and for a bare `:::` with no kind (`kind` is `undefined`).
 */
export function containerColor(theme: Required<MarkdownTheme>, kind: string | undefined): string {
  if (kind === undefined) return theme.containerDefaultColor;
  return theme.containerColors[kind.toLowerCase()] ?? theme.containerDefaultColor;
}
