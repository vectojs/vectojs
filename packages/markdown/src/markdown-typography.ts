/**
 * Typographic replacements: `--`/`---` to en/em dash, `...` to `…`, `(c)`/`(r)`/
 * `(tm)` to `©`/`®`/`™`, `+-` to `±`, and repeated `!`/`,` collapsing —
 * `markdown-it`'s `typographer: true` set, minus smart quotes (see below).
 *
 * Ported as a **pure text transform** rather than a new tokenizer or `marked`
 * extension, because that is what it is upstream too: `markdown-it`'s own
 * `replacements` rule runs as a `core` pass over already-tokenized `text`
 * content, not a grammar rule, and every substitution here is describable the
 * same way — a regex over a string that changes no token boundaries. Applying
 * it as the last step before a `text`-bearing span is pushed keeps this
 * completely orthogonal to every other inline arm: a bold/italic/code run's
 * content transforms identically to a plain paragraph's, because it is the same
 * function call, not a special case duplicated per arm.
 *
 * ## Off by default, unlike every other construct in this package
 *
 * `markdown-it` itself defaults `typographer` to `false`, and this mirrors
 * that rather than picking a different default for parity's own sake: the
 * transform is lossy (a real `--` a caller wanted to keep literal, e.g. a CLI
 * flag or a code-adjacent range, becomes an en dash with no way back short of
 * disabling the whole feature) and every other construct in this package
 * (subscript, superscript, ins/mark, emoji, footnotes) is instead
 * unconditionally-on syntax recognition with no lossy default to weigh.
 * `theme.typographer` (default `false`) is the gate, checked once per paragraph
 * of text collection rather than per span, so a caller who never opts in pays
 * nothing beyond the one boolean check `collectSpans` already does today for
 * `inherited`.
 *
 * ## Smart quotes are deliberately NOT ported
 *
 * `markdown-it`'s `smartquotes` rule curls straight quotes into `‘’“”` by
 * walking the FULL inline-token sequence of one block with a stack that
 * matches an opening quote to its closing partner, consulting the previous and
 * next token's own trailing/leading character across token boundaries (see
 * `references/markdown-it/lib/rules_core/smartquotes.mjs`'s `process_inlines`).
 * That is not a per-span text transform — it is a second pass over
 * `collectSpans`' entire OUTPUT array, with cross-span state (the open-quote
 * stack) and lookback/lookahead into neighboring spans' text. Porting it here
 * would mean walking `out` after the fact, which every call site of
 * `collectSpans`/`applyTypography` would have to remember to do, and getting it
 * wrong reads as a rendering defect (mismatched curly quotes) rather than a
 * missing feature. Left unimplemented; a caller wanting curled quotes still
 * gets straight ones, the same honest fallback every unsupported construct in
 * this package gets.
 */

/**
 * Cheap reject: none of the four substitution groups' trigger characters are
 * present. Every plain paragraph in an ordinary document fails this once and
 * pays nothing further — this runs on every span's text when the theme flag is
 * on, so the reject has to be cheaper than the substitutions it is guarding.
 */
const CANDIDATE_RE = /\+-|\.\.|\?\?\?\?|!!!!|,,|--|\((?:c|r|tm)\)/i;

/** `(c)`, `(r)`, `(tm)`, case-insensitive. */
const SCOPED_ABBR_RE = /\((c|r|tm)\)/gi;
const SCOPED_ABBR: Readonly<Record<string, string>> = { c: '©', r: '®', tm: '™' };

/**
 * Apply typographic substitutions to one run of plain text.
 *
 * Order matters and mirrors `markdown-it`'s own rule (`replace_scoped` before
 * `replace_rare`, and within the latter: `+-`, then `...`, then the
 * `?`/`!`-adjacent ellipsis correction, then `!!!!`/`,,`, then em-dash, then
 * en-dash):
 *
 * - `+-` before `...`: neither can produce the other's trigger character, so
 *   order between them is actually inert, but matching upstream's order keeps
 *   this auditable against it rather than needing its own independent proof.
 * - The em-dash pass runs before the en-dash pass. `---` is three hyphens; the
 *   en-dash patterns below both require a NON-hyphen on the dash-adjacent side
 *   (`(?=[^-]|$)` / preceded by whitespace or a non-hyphen-non-space), so `---`
 *   itself never matches either en-dash pattern regardless of order — but a
 *   FOUR-hyphen run (`----`) would: the em-dash regex only consumes exactly
 *   three of the four hyphens (`(^|[^-])---(?=[^-]|$)` requires its OWN
 *   boundary hyphens to be non-hyphen), leaving a leftover single hyphens on
 *   either side that the leftover isn't itself `--`. Verified empirically
 *   against `markdown-it`'s reference implementation that `----` and `---`
 *   both resolve to one em dash: `----` is not decomposed into em+en, and
 *   running en-dash first would have changed that (the outer pair of the four
 *   hyphens would each independently look like the START of a `--` run before
 *   the em-dash pass ever saw the middle two as a `---`).
 */
export function applyTypography(text: string): string {
  if (!CANDIDATE_RE.test(text)) return text;
  return (
    text
      .replace(SCOPED_ABBR_RE, (match, name: string) => SCOPED_ABBR[name.toLowerCase()] ?? match)
      .replace(/\+-/g, '±')
      // `..`, `...`, `.......` -> `…`, but a `?`/`!` directly before the run
      // keeps two literal dots (`?..`/`!..`) rather than becoming `?…`/`!…` —
      // matches markdown-it's own carve-out for a trailing-question/exclaim
      // ellipsis, which reads as hesitation punctuation rather than an elision.
      .replace(/\.{2,}/g, '…')
      .replace(/([?!])…/g, '$1..')
      // Four or more `?`/`!` collapse to exactly three (its own siblings, not a
      // cross-character mix): `????` -> `???`, `!!!!!` -> `!!!`.
      .replace(/([?!])\1{3,}/g, '$1$1$1')
      .replace(/,{2,}/g, ',')
      // Em dash: `---` with a non-hyphen (or start-of-line) on each side.
      .replace(/(^|[^-])---(?=[^-]|$)/gm, '$1\u2014')
      // En dash: `--` either surrounded by whitespace/line-boundaries, or by a
      // non-hyphen-non-space character on both sides (`word--word`). Two
      // patterns rather than one because the whitespace-flanked form must not
      // require a non-space CHARACTER on the far side (there may be none, at
      // start/end of line) while the word-flanked form must not swallow a
      // leading/trailing space into the dash.
      .replace(/(^|\s)--(?=\s|$)/gm, '$1\u2013')
      .replace(/(^|[^-\s])--(?=[^-\s]|$)/gm, '$1\u2013')
  );
}
