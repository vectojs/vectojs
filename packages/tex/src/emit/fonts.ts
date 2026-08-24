/**
 * Resolves a KaTeX layout node's CSS classes to a concrete font file.
 *
 * This exists because of a structural gap in KaTeX's span tree: `SymbolNode`
 * carries the *metrics* it was measured with (`height`, `depth`, `width`,
 * `italic`, `skew`) but **not the font those metrics came from**. `makeSymbol`
 * looks the font up, reads the metrics, and then keeps only a CSS class — the
 * browser is expected to re-derive the family from a stylesheet at paint time.
 *
 * A canvas has no stylesheet, so the emit layer has to redo that derivation. The
 * table below is the machine-readable form of `src/styles/katex.scss`, where the
 * mapping is spread across ~20 rules that set `font-family`, `font-weight` and
 * `font-style` independently and then compose.
 *
 * Verified against that stylesheet at KaTeX `5a5bf206`. Each entry names the rule
 * it encodes so the two can be re-diffed on a version bump.
 */

/** A resolved font: the file stem used by both `fontMetricsData` and the TTFs. */
export type FontName =
  | 'AMS-Regular'
  | 'Caligraphic-Regular'
  | 'Caligraphic-Bold'
  | 'Fraktur-Regular'
  | 'Fraktur-Bold'
  | 'Main-Regular'
  | 'Main-Bold'
  | 'Main-Italic'
  | 'Main-BoldItalic'
  | 'Math-Italic'
  | 'Math-BoldItalic'
  | 'SansSerif-Regular'
  | 'SansSerif-Bold'
  | 'SansSerif-Italic'
  | 'Script-Regular'
  | 'Typewriter-Regular'
  | 'Size1-Regular'
  | 'Size2-Regular'
  | 'Size3-Regular'
  | 'Size4-Regular';

/** A font family plus the weight/style axes a class may set. */
interface FontFace {
  family: string;
  bold?: boolean;
  italic?: boolean;
}

/**
 * Class → font face, encoding `katex.scss` lines 85-181.
 *
 * A class may set only one axis (`.textbf` sets weight, `.textit` sets style), so
 * these compose rather than override: `mathnormal` picks the family and italic,
 * and a sibling `textbf` can still add weight. Resolution folds them in class
 * order, which matches CSS cascade for rules of equal specificity.
 */
const CLASS_TO_FACE: Record<string, FontFace> = {
  // Text font families.
  textrm: { family: 'Main' },
  textsf: { family: 'SansSerif' },
  texttt: { family: 'Typewriter' },
  // Text weight and shape, which set no family of their own.
  textbf: { family: '', bold: true },
  textit: { family: '', italic: true },
  // Math fonts.
  mathnormal: { family: 'Math', italic: true },
  mathit: { family: 'Main', italic: true },
  mathrm: { family: '', italic: false },
  mathbf: { family: 'Main', bold: true },
  boldsymbol: { family: 'Math', bold: true, italic: true },
  amsrm: { family: 'AMS' },
  mathbb: { family: 'AMS' },
  textbb: { family: 'AMS' },
  mathcal: { family: 'Caligraphic' },
  mathfrak: { family: 'Fraktur' },
  textfrak: { family: 'Fraktur' },
  mathboldfrak: { family: 'Fraktur', bold: true },
  textboldfrak: { family: 'Fraktur', bold: true },
  mathtt: { family: 'Typewriter' },
  mathscr: { family: 'Script' },
  textscr: { family: 'Script' },
  mathsf: { family: 'SansSerif' },
  mathboldsf: { family: 'SansSerif', bold: true },
  textboldsf: { family: 'SansSerif', bold: true },
  mathsfit: { family: 'SansSerif', italic: true },
  mathitsf: { family: 'SansSerif', italic: true },
  textitsf: { family: 'SansSerif', italic: true },
  mainrm: { family: 'Main', italic: false },
};

/**
 * The `delimsizing size1..size4` classes, which select a *different font* rather
 * than scaling one. KaTeX ships four dedicated fonts of progressively larger
 * delimiters because a scaled parenthesis has the wrong stroke weight.
 *
 * Encodes `katex.scss:367-371`.
 */
const DELIM_SIZE_FONTS: Record<string, FontName> = {
  size1: 'Size1-Regular',
  size2: 'Size2-Regular',
  size3: 'Size3-Regular',
  size4: 'Size4-Regular',
};

/**
 * Classes that pick a font outright, independent of the family/weight/style
 * composition.
 *
 * Two groups, both found by validating the resolver against `fontMetricsData` and
 * seeing which symbols resolved to a font whose table did not contain them:
 *
 * - **Big operators** (`katex.scss:393-403`). `\sum` and `\int` in inline style are
 *   set in Size1 and in display style in Size2; neither glyph exists in Main at
 *   all, so getting this wrong is not a size error but a missing glyph.
 * - **Stacked delimiter pieces** (`katex.scss:373-381`). A delimiter too tall for
 *   even Size4 is assembled from top/middle/bottom pieces, and
 *   `delimiter.ts:167-174` tags each piece `delim-size1` or `delim-size4` to say
 *   which font the piece came from.
 */
const DIRECT_FONT_CLASSES: Record<string, FontName> = {
  'small-op': 'Size1-Regular',
  'large-op': 'Size2-Regular',
  'delim-size1': 'Size1-Regular',
  'delim-size4': 'Size4-Regular',
};

/**
 * Which weight/style combinations each family actually ships.
 *
 * Asking for `Script-Bold` is not a rendering bug to be papered over — it means
 * the resolution logic produced a face that does not exist, and silently falling
 * back would hide it. `resolveFont` degrades to the family's Regular and the
 * caller can report it.
 */
const AVAILABLE: Record<string, Set<string>> = {
  AMS: new Set(['Regular']),
  Caligraphic: new Set(['Regular', 'Bold']),
  Fraktur: new Set(['Regular', 'Bold']),
  Main: new Set(['Regular', 'Bold', 'Italic', 'BoldItalic']),
  Math: new Set(['Italic', 'BoldItalic']),
  SansSerif: new Set(['Regular', 'Bold', 'Italic']),
  Script: new Set(['Regular']),
  Typewriter: new Set(['Regular']),
  Size1: new Set(['Regular']),
  Size2: new Set(['Regular']),
  Size3: new Set(['Regular']),
  Size4: new Set(['Regular']),
};

/**
 * The default face for math mode.
 *
 * `.katex` sets `font: normal 1.21em KaTeX_Main`, so a symbol with no font class
 * — a relation, a delimiter, a digit — is Main-Regular. Exported for the
 * vendoring drift guard in `scripts/vendor-katex.ts`.
 */
export const DEFAULT_FONT: FontName = 'Main-Regular';

export interface ResolvedFont {
  font: FontName;
  /**
   * True when the requested weight/style did not exist and the Regular face was
   * substituted. Surfaced rather than swallowed so a caller can count it.
   */
  substituted: boolean;
}

/**
 * Resolves the font for a symbol, given its own classes innermost-last.
 *
 * **Font selection is inherited, not local.** This is the single most important
 * thing about this function, and it is easy to get wrong because the failure is
 * quiet: `\left(` produces a `SymbolNode` with an *empty* class list nested under
 * `Span[delimsizing size1]`, so resolving from the symbol's own classes yields
 * Main-Regular and silently draws a short parenthesis where a tall one belongs.
 * The glyph exists in both fonts, so nothing errors.
 *
 * Measured at KaTeX `5a5bf206`: `Size1-Regular` U+0028 is
 * `depth 0.35001, height 0.85, width 0.45834`, exactly the values the nested
 * `SymbolNode` carries, which is how the inheritance was confirmed rather than
 * assumed. Every font-bearing class is a CSS `font-family` rule on an ancestor, so
 * the emitter must thread the chain down.
 *
 * Pass the concatenation of every ancestor's classes followed by the symbol's own,
 * outermost first. Later entries win, matching CSS cascade for rules of equal
 * specificity.
 *
 * `delimsizing` is tested before the family composition because its `size1`-`size4`
 * classes collide with the `katex-sizing size1`-`size11` scale classes, which mean
 * something entirely different — a font-size ratio rather than a font file.
 * Upstream distinguishes them with a descendant selector; here it is the presence
 * of `delimsizing` in the chain.
 */
export function resolveFont(classes: readonly string[]): ResolvedFont {
  if (classes.includes('delimsizing')) {
    for (const cls of classes) {
      const font = DELIM_SIZE_FONTS[cls];
      if (font) return { font, substituted: false };
    }
  }

  // Checked before family composition, because these classes appear *alongside*
  // an `mop`/`mord` math class that carries no family, and the glyph exists only
  // in the font they name.
  for (const cls of classes) {
    const font = DIRECT_FONT_CLASSES[cls];
    if (font) return { font, substituted: false };
  }

  let family = '';
  let bold = false;
  let italic = false;

  for (const cls of classes) {
    const face = CLASS_TO_FACE[cls];
    if (!face) continue;
    if (face.family) family = face.family;
    if (face.bold !== undefined) bold = face.bold;
    if (face.italic !== undefined) italic = face.italic;
  }

  if (!family) {
    // No family class: the `.katex` default, but honour a weight/shape class
    // that appeared alone (`\textbf{x}` in text mode yields `textbf` only).
    family = 'Main';
  }

  const wanted = bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular';
  const available = AVAILABLE[family];

  if (available?.has(wanted)) {
    return { font: `${family}-${wanted}` as FontName, substituted: false };
  }

  // `Math` has no Regular: upright math is set in Main. This is a real KaTeX
  // convention, not a missing file, so it is not reported as a substitution.
  if (family === 'Math' && wanted === 'Regular') {
    return { font: DEFAULT_FONT, substituted: false };
  }
  if (family === 'Math' && wanted === 'Bold') {
    return { font: 'Math-BoldItalic', substituted: false };
  }

  const fallback = `${family}-Regular` as FontName;
  if (available?.has('Regular')) {
    return { font: fallback, substituted: wanted !== 'Regular' };
  }
  return { font: DEFAULT_FONT, substituted: true };
}

/**
 * The font-size ratio carried by a `katex-sizing reset-size<from> size<to>` pair.
 *
 * These come from `Options.sizingClasses()` and are how the script/scriptscript
 * cascade reaches the renderer: a superscript is not laid out with smaller
 * metrics, it is laid out at full size inside a box that is then scaled. The
 * multipliers are the same array as `sizeMultipliers` in `Options.ts`, duplicated
 * in `katex.scss` as `$sizes`.
 *
 * Returns 1 when the classes carry no sizing, so a caller can multiply
 * unconditionally.
 */
const SIZE_MULTIPLIERS = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.44, 1.728, 2.074, 2.488];

export function sizingRatio(classes: readonly string[]): number {
  if (!classes.includes('katex-sizing')) return 1;

  let from = -1;
  let to = -1;
  for (const cls of classes) {
    if (cls.startsWith('reset-size')) {
      from = Number.parseInt(cls.slice('reset-size'.length), 10);
    } else if (cls.startsWith('size')) {
      to = Number.parseInt(cls.slice('size'.length), 10);
    }
  }

  if (!Number.isFinite(from) || !Number.isFinite(to)) return 1;
  const fromMultiplier = SIZE_MULTIPLIERS[from - 1];
  const toMultiplier = SIZE_MULTIPLIERS[to - 1];
  if (!fromMultiplier || !toMultiplier) return 1;
  return toMultiplier / fromMultiplier;
}

export { SIZE_MULTIPLIERS, CLASS_TO_FACE, DELIM_SIZE_FONTS, DIRECT_FONT_CLASSES };
