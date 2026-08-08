/**
 * Named theme presets for `@vectojs/markdown`.
 *
 * Each preset is a full {@link MarkdownTheme} partial whose color tokens are
 * sourced verbatim from the palette's upstream specification:
 *
 * - **`githubDark`** — GitHub Dark Default (Primer dark palette).
 *   Source: `primer/github-vscode-theme` / `rouge-ruby/rouge` Primer primitives.
 * - **`githubLight`** — GitHub Light Default (Primer light palette).
 *   Source: same — P_RED_5, P_BLUE_6/P_BLUE_8, P_GRAY_5, P_GRAY_9, canvas tokens.
 * - **`dracula`** — Dracula Classic.
 *   Source: https://draculatheme.com/spec and https://github.com/dracula/dracula-theme
 * - **`solarizedDark`** — Solarized dark mode.
 *   Source: https://ethanschoonover.com/solarized/ (L*a*b canonical, sRGB values).
 * - **`solarizedLight`** — Solarized light mode.
 *   Source: same palette, base-pair swapped per Schoonover's own CSS snippet
 *   (light: `base3:base0` background/foreground, `base2` background highlight,
 *   `base1` comments; dark: `base03:base0`, `base02`, `base01`).
 *
 * Spacing and typography keys are NOT set in presets: they remain at
 * {@link DEFAULT_THEME} defaults so a caller who passes `theme: 'dracula'`
 * gets Dracula colors on a correctly-spaced layout without having to restate
 * every dimension.
 *
 * Light presets apply a CONTRAST PASS on translucent overlays
 * (`codeBgColor`, `tableHeaderBgColor`, `containerBgColor`, `markHighlightColor`,
 * `hrColor`): the stock theme is dark and its translucent values composite
 * against a near-black surface. On a white/cream background the same RGBA
 * values produce the wrong visual weight, so light presets use opaque or
 * differently-composited colors derived from the palette instead.
 */

import { resolveTheme, type MarkdownTheme } from './theme';

/** Names of the built-in theme presets. */
export type MarkdownThemePresetName =
  | 'githubDark'
  | 'githubLight'
  | 'dracula'
  | 'solarizedDark'
  | 'solarizedLight';

// ── GitHub Dark Default ───────────────────────────────────────────────────────
// Primer dark palette sourced from rouge-ruby/rouge lib/rouge/themes/github.rb
// (P_GRAY_8 = #161b22 panel, P_GRAY_9 = #24292f fg, P_BLUE_2 = #79c0ff constant,
//  P_RED_3 = #ff7b72 keyword, P_BLUE_1 = #a5d6ff string, P_GRAY_3 = #8b949e comment,
//  P_ORANGE_2 = #ffa657 variable) and primer/github-vscode-theme
// (canvas.default #0d1117, fg.default #e6edf3, accent.fg #58a6ff).
const GITHUB_DARK: MarkdownTheme = {
  textColor: '#e6edf3',
  headingColor: '#e6edf3',
  codeColor: '#a5d6ff',
  // Solid dark panel — not a translucent overlay since the canvas bg is dark.
  codeBgColor: '#161b22',
  quoteBorderColor: '#30363d',
  hrColor: '#30363d',
  tableBgColor: '#010409',
  tableHeaderBgColor: '#161b22',
  linkColor: '#58a6ff',
  mathFallbackColor: '#e3b341',
  markHighlightColor: 'rgba(187, 128, 9, 0.4)',
  containerColors: {
    note: '#58a6ff',
    info: '#58a6ff',
    tip: '#3fb950',
    warning: '#d29922',
    danger: '#f85149',
    caution: '#f85149',
  },
  containerDefaultColor: '#8b949e',
  containerBgColor: 'rgba(139, 148, 158, 0.08)',
  // GitHub Dark Default syntax (Primer primitives / rouge github dark palette):
  // keyword = P_RED_3 #ff7b72, string = P_BLUE_1 #a5d6ff,
  // comment = P_GRAY_3 #8b949e, number = P_BLUE_2 #79c0ff.
  syntaxKeywordColor: '#ff7b72',
  syntaxStringColor: '#a5d6ff',
  syntaxCommentColor: '#8b949e',
  syntaxNumberColor: '#79c0ff',
};

// ── GitHub Light Default ──────────────────────────────────────────────────────
// Primer light palette sourced from rouge-ruby/rouge lib/rouge/themes/github.rb
// (P_GRAY_9 = #24292f fg, P_GRAY_5 = #6e7781 comment, P_RED_5 = #cf222e keyword,
//  P_BLUE_6 = #0550ae number/constant, P_BLUE_8 = #0a3069 string,
//  P_PURPLE_5 = #8250df entity) and Primer design-systems.one / designsystems.one
// (canvas.default #ffffff, canvas.subtle #f6f8fa, fg.default #1f2328,
//  accent.fg #0969da, border.default #d0d7de).
//
// CONTRAST PASS (light surface):
//   codeBgColor: solid #f6f8fa (canvas.subtle) — translucent dark overlay unusable.
//   tableHeaderBgColor: solid #eaeef2 (canvas.inset) — same reason.
//   containerBgColor: rgba(208,215,222,0.2) — light slate tint.
//   markHighlightColor: rgba(210,153,34,0.25) — amber highlight legible on white.
//   hrColor: #d0d7de — border.default, no alpha needed on light bg.
const GITHUB_LIGHT: MarkdownTheme = {
  textColor: '#1f2328',
  headingColor: '#1f2328',
  codeColor: '#0550ae',
  codeBgColor: '#f6f8fa',
  quoteBorderColor: '#0969da',
  hrColor: '#d0d7de',
  tableBgColor: '#ffffff',
  tableHeaderBgColor: '#eaeef2',
  linkColor: '#0969da',
  mathFallbackColor: '#9a6700',
  markHighlightColor: 'rgba(210, 153, 34, 0.25)',
  containerColors: {
    note: '#0969da',
    info: '#0969da',
    tip: '#1a7f37',
    warning: '#9a6700',
    danger: '#cf222e',
    caution: '#cf222e',
  },
  containerDefaultColor: '#59636e',
  containerBgColor: 'rgba(208, 215, 222, 0.2)',
  // GitHub Light Default syntax (Primer primitives / rouge github light palette):
  // keyword = P_RED_5 #cf222e, string = P_BLUE_8 #0a3069,
  // comment = P_GRAY_5 #6e7781, number = P_BLUE_6 #0550ae.
  syntaxKeywordColor: '#cf222e',
  syntaxStringColor: '#0a3069',
  syntaxCommentColor: '#6e7781',
  syntaxNumberColor: '#0550ae',
};

// ── Dracula Classic ───────────────────────────────────────────────────────────
// All hex values from the official Dracula specification:
// https://draculatheme.com/spec and https://github.com/dracula/dracula-theme
// Background #282a36, Foreground #f8f8f2, Comment/Current-Line #6272a4,
// Cyan #8be9fd, Green #50fa7b, Orange #ffb86c, Pink #ff79c6,
// Purple #bd93f9, Red #ff5555, Yellow #f1fa8c.
//
// Markdown-element mapping follows draculatheme.com/markdown-css:
// headings=Purple, links=Cyan, code=Green, bold=Orange, italic=Yellow,
// blockquotes=Comment. Syntax: keywords=Pink, strings=Yellow,
// comments=Comment, numbers=Orange.
const DRACULA: MarkdownTheme = {
  textColor: '#f8f8f2',
  headingColor: '#bd93f9',
  codeColor: '#50fa7b',
  codeBgColor: '#282a36',
  quoteBorderColor: '#6272a4',
  hrColor: 'rgba(98, 114, 164, 0.4)',
  tableBgColor: 'rgba(40, 42, 54, 0.6)',
  tableHeaderBgColor: 'rgba(68, 71, 90, 0.5)',
  linkColor: '#8be9fd',
  mathFallbackColor: '#ffb86c',
  markHighlightColor: 'rgba(241, 250, 140, 0.3)',
  containerColors: {
    note: '#8be9fd',
    info: '#8be9fd',
    tip: '#50fa7b',
    warning: '#ffb86c',
    danger: '#ff5555',
    caution: '#ff5555',
  },
  containerDefaultColor: '#6272a4',
  containerBgColor: 'rgba(98, 114, 164, 0.1)',
  // Dracula syntax: keywords=Pink (#ff79c6), strings=Yellow (#f1fa8c),
  // comments=Comment (#6272a4), numbers/constants=Orange (#ffb86c).
  syntaxKeywordColor: '#ff79c6',
  syntaxStringColor: '#f1fa8c',
  syntaxCommentColor: '#6272a4',
  syntaxNumberColor: '#ffb86c',
};

// ── Solarized Dark ────────────────────────────────────────────────────────────
// Canonical values from https://ethanschoonover.com/solarized/ (L*a*b sRGB).
// Dark pairing (Schoonover's own rebase mixin): background=base03 #002b36,
// background-highlight=base02 #073642, body-text=base0 #839496,
// body-emphasis=base1 #93a1a1, comments=base01 #586e75.
// Accent colors: blue #268bd2 (links), cyan #2aa198, green #859900,
// yellow #b58900, orange #cb4b16, magenta #d33682, violet #6c71c4.
// Syntax (canonical Solarized assignments, altercation/vim-colors-solarized):
// keyword=green #859900, string=cyan #2aa198, comment=base01 #586e75,
// number=cyan #2aa198 (Solarized treats constants and strings identically).
const SOLARIZED_DARK: MarkdownTheme = {
  textColor: '#839496',
  headingColor: '#93a1a1',
  codeColor: '#2aa198',
  codeBgColor: '#073642',
  quoteBorderColor: '#6c71c4',
  hrColor: 'rgba(88, 110, 117, 0.4)',
  tableBgColor: 'rgba(0, 43, 54, 0.6)',
  tableHeaderBgColor: 'rgba(7, 54, 66, 0.8)',
  linkColor: '#268bd2',
  mathFallbackColor: '#b58900',
  markHighlightColor: 'rgba(181, 137, 0, 0.3)',
  containerColors: {
    note: '#268bd2',
    info: '#268bd2',
    tip: '#859900',
    warning: '#b58900',
    danger: '#dc322f',
    caution: '#dc322f',
  },
  containerDefaultColor: '#586e75',
  containerBgColor: 'rgba(88, 110, 117, 0.1)',
  syntaxKeywordColor: '#859900',
  syntaxStringColor: '#2aa198',
  syntaxCommentColor: '#586e75',
  syntaxNumberColor: '#b58900',
};

// ── Solarized Light ───────────────────────────────────────────────────────────
// Same canonical palette as dark, base-pair swapped per Schoonover's own SCSS:
// .light { rebase($base3,$base2,$base1,$base0,$base00,$base01,$base02,$base03) }
// meaning: background=base3 #fdf6e3, bg-highlight=base2 #eee8d5,
// body-text=base00 #657b83, body-emphasis=base01 #586e75, comments=base1 #93a1a1.
// Accent colors are IDENTICAL in both modes — Solarized's core design property.
//
// CONTRAST PASS (cream/parchment surface):
//   codeBgColor: solid base2 #eee8d5 — translucent dark overlay would be invisible.
//   tableHeaderBgColor: solid #e0dac9 (slightly darker base2 variant) — same reason.
//   containerBgColor: rgba(147,161,161,0.15) — light neutral tint.
//   markHighlightColor: rgba(181,137,0,0.2) — amber on cream, lower alpha than dark.
//   hrColor: rgba(147,161,161,0.5) — base1 with controlled opacity.
const SOLARIZED_LIGHT: MarkdownTheme = {
  textColor: '#657b83',
  headingColor: '#586e75',
  codeColor: '#2aa198',
  codeBgColor: '#eee8d5',
  quoteBorderColor: '#6c71c4',
  hrColor: 'rgba(147, 161, 161, 0.5)',
  tableBgColor: '#fdf6e3',
  tableHeaderBgColor: '#e0dac9',
  linkColor: '#268bd2',
  mathFallbackColor: '#cb4b16',
  markHighlightColor: 'rgba(181, 137, 0, 0.2)',
  containerColors: {
    note: '#268bd2',
    info: '#268bd2',
    tip: '#859900',
    warning: '#b58900',
    danger: '#dc322f',
    caution: '#dc322f',
  },
  containerDefaultColor: '#93a1a1',
  containerBgColor: 'rgba(147, 161, 161, 0.15)',
  // Syntax accent colors are identical in light and dark Solarized.
  syntaxKeywordColor: '#859900',
  syntaxStringColor: '#2aa198',
  syntaxCommentColor: '#93a1a1',
  syntaxNumberColor: '#b58900',
};

/** Look-up table from preset name to its partial {@link MarkdownTheme}. */
export const PRESET_THEMES: Readonly<Record<MarkdownThemePresetName, MarkdownTheme>> = {
  githubDark: GITHUB_DARK,
  githubLight: GITHUB_LIGHT,
  dracula: DRACULA,
  solarizedDark: SOLARIZED_DARK,
  solarizedLight: SOLARIZED_LIGHT,
};

/**
 * Return `true` if `value` is a recognised {@link MarkdownThemePresetName}.
 *
 * Use this to branch on `theme?: MarkdownThemePresetName | MarkdownTheme`
 * before calling {@link resolvePresetTheme}.
 */
export function isPresetName(value: unknown): value is MarkdownThemePresetName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PRESET_THEMES, value);
}

/**
 * Resolve a `theme` option that may be a preset name, a full/partial
 * {@link MarkdownTheme}, or `undefined`, into a `Required<MarkdownTheme>`.
 *
 * Always calls {@link resolveTheme} rather than spreading {@link PRESET_THEMES}
 * or `DEFAULT_THEME` directly, so the derived keys (`tableFontSize` from
 * `fontSize`, `quoteTextColor`/`footnoteColor` from `textColor`/`linkColor`)
 * still apply on top of a preset exactly as they do for a hand-written theme —
 * a preset that sets `linkColor` but not `footnoteColor` should still get a
 * footnote marker in the preset's link color, not the stock accent.
 *
 * A plain `MarkdownTheme` object is passed straight to `resolveTheme` unchanged
 * (this is the pre-existing, non-preset path); a preset name is looked up in
 * {@link PRESET_THEMES} first.
 */
export function resolvePresetTheme(
  theme?: MarkdownThemePresetName | MarkdownTheme,
): Required<MarkdownTheme> {
  if (isPresetName(theme)) return resolveTheme(PRESET_THEMES[theme]);
  return resolveTheme(theme);
}
