import type { Token, TokenizerAndRendererExtension } from 'marked';

/**
 * GFM footnotes: the two `marked` tokenizer extensions, their token types, and
 * the marker text a reference renders as.
 *
 * This module is the **single** registration source for both `marked.use` call
 * sites — `Markdown.ts` and `MarkdownWorker.ts`. They must agree exactly: a
 * worker lexing with a different extension set than the main thread produces
 * tokens the renderer has no arm for, which is why `MarkdownWorker.ts` already
 * carries a comment demanding lockstep for the math tokenizers. Sharing one
 * array makes the divergence impossible rather than merely discouraged, and it
 * costs nothing in the worker bundle: `scripts/build-worker.js` runs esbuild
 * with `bundle: true`, so this import is inlined into the emitted worker source.
 *
 * Deliberately holds **no** entity, theme or `@vectojs/*` import. The whole
 * module is inlined into the worker string, so a dependency on the render layer
 * would drag the UI packages into a worker that only lexes text.
 */

/**
 * A footnote reference — `[^1]` or `[^note]` — as it appears mid-sentence.
 *
 * Carries `label`, not `text`. That is load-bearing in two places: `Markdown`'s
 * `producesEntity` falls back to `'text' in token` for an unknown type and
 * `renderToken`'s `default:` arm renders `.text` as a plain block, so a token
 * spelling its payload `text` would silently route through the fallback and
 * reproduce the very defect this replaces. A distinct field name makes an
 * unhandled footnote token render nothing instead of rendering wrongly.
 */
export interface FootnoteRefToken {
  type: 'footnoteRef';
  raw: string;
  /** The label exactly as written between `[^` and `]`, e.g. `1` or `note`. */
  label: string;
}

/**
 * A footnote definition — `[^1]: The note.` — as its own block, optionally
 * followed by indented continuation lines that extend the body across
 * multiple paragraphs (`markdown-it`'s and GFM's own shape for this).
 */
export interface FootnoteDefToken {
  type: 'footnoteDef';
  raw: string;
  /** The label exactly as written, matching a {@link FootnoteRefToken}'s. */
  label: string;
  /** The header line's body text, source text with inline markup unparsed. */
  body: string;
  /**
   * Block tokens for any indented continuation content after the header line
   * (further paragraphs, lists, code, …), block-lexed exactly like a
   * blockquote's `tokens`. Empty when the definition is single-line, which is
   * the overwhelming majority — a definition is only ever multi-paragraph when
   * the source actually indents a second block under it.
   */
  tokens: Token[];
}

/**
 * A label: one or more characters that are neither whitespace nor `]`.
 *
 * Broader than GFM's own `[a-zA-Z0-9_-]+` on purpose. A label is never resolved
 * against anything — the marker prints what was written and the definition
 * renders where it stands — so a stricter class would only decide which
 * footnotes silently fall back to being literal text, and `[^ref.1]` reading as
 * prose while `[^ref-1]` reads as a footnote is not a distinction a reader can
 * predict. Excluding whitespace is what keeps `[^ ]` and prose in brackets from
 * matching.
 */
const LABEL = '([^\\]\\s]+)';

/** `[^label]` at the cursor. */
const REF_RE = new RegExp(`^\\[\\^${LABEL}\\]`);

/**
 * `[^label]:` header line, with up to three spaces of indent. Captures the
 * header's own body text (group 2) and swallows one trailing newline if
 * present — {@link consumeContinuation} takes over from there.
 */
const HEADER_RE = new RegExp(`^ {0,3}\\[\\^${LABEL}\\]:[ \\t]*([^\\n]*)\\n?`);

/** A line containing only whitespace. */
function isBlankLine(line: string): boolean {
  return /^[ \t]*$/.test(line);
}

/** An indented continuation line: four spaces, or a tab, of leading indent. */
const CONT_LINE_RE = /^(?: {4}| {0,3}\t)/;

/**
 * Consume indented continuation lines after a definition's header, per
 * `markdown-it`'s and GFM's own shape for a multi-paragraph footnote body: any
 * run of blank lines followed by at least one four-space-or-tab-indented line
 * extends the definition; the first non-blank, non-indented line ends it.
 *
 * **Never commits an unconfirmed trailing blank line.** A naive scan that
 * swallows blank lines eagerly and only THEN checks the next line would, at
 * the header-alone case `'[^1]: Note.\n\n'`, greedily consume the blank line
 * even though nothing indented follows — corrupting `raw` to include a blank
 * line that belongs to whatever comes next, not to this definition. Instead
 * this looks ahead through a whole run of blank lines before deciding whether
 * to commit them, and rolls back to `offset` (the last confirmed commit point)
 * the moment the run turns out not to lead to a continuation line. This is
 * exactly the shape `findBodyEnd` in `markdown-container.ts` uses to resolve
 * the analogous ambiguity for `:::` fences, applied to a different grammar.
 *
 * Also returns whether the continuation is still `open` (ran off the end of
 * `rest` while still indented, or while still inside a blank-line run) — this
 * mirrors `findBodyEnd`'s `-1` sentinel and is what {@link hasFootnoteDefOpener}
 * uses for the incremental-lex degrade check below.
 */
function consumeContinuation(rest: string): { raw: string; body: string; open: boolean } {
  let offset = 0;
  for (;;) {
    // Look ahead through a run of blank lines without committing them yet.
    let probe = offset;
    for (;;) {
      const lineEnd = rest.indexOf('\n', probe);
      if (lineEnd === -1) return finalize(offset, true); // ran off the end mid-blank-run
      const line = rest.slice(probe, lineEnd);
      if (!isBlankLine(line)) break;
      probe = lineEnd + 1;
    }
    // `probe` now sits at the first non-blank line after the run. Commit the
    // blank run (and this line) only if it actually continues the body.
    const lineEnd = rest.indexOf('\n', probe);
    const lineWithNl = lineEnd === -1 ? rest.slice(probe) : rest.slice(probe, lineEnd + 1);
    const line = lineEnd === -1 ? rest.slice(probe) : rest.slice(probe, lineEnd);
    if (!CONT_LINE_RE.test(line)) return finalize(offset, false); // not a continuation: stop before the blank run
    offset = probe + lineWithNl.length;
    if (lineEnd === -1) return finalize(offset, true); // continuation line ran off the end
  }

  function finalize(end: number, open: boolean): { raw: string; body: string; open: boolean } {
    const committedRaw = rest.slice(0, end);
    // De-indent each continuation line by its four-space/tab prefix; blank
    // lines stay blank rather than losing their (nonexistent) indent.
    const body = committedRaw
      .split('\n')
      .map((line) => (isBlankLine(line) ? '' : line.replace(CONT_LINE_RE, '')))
      .join('\n');
    return { raw: committedRaw, body, open };
  }
}

/**
 * Whether `text` contains a `[^label]:` header that {@link HEADER_RE} would
 * match, ANYWHERE in the document — the exact condition under which
 * {@link consumeContinuation} can still be scanning forward (an open
 * continuation) when more text arrives.
 *
 * Used by `incrementalLex.ts`'s degrade check, mirroring `hasBlockMathOpener`
 * and `hasContainerOpener`: a footnote definition's continuation-consuming
 * tokenizer has the exact same forward-reach hazard those two document, now
 * that it can span a blank line. Deliberately does not try to determine
 * whether a SPECIFIC header's continuation is still open — that would need to
 * replicate the tokenizer's own scan — and instead degrades on the mere
 * presence of any header, which is safe (if conservative) the same way
 * `hasBlockMathOpener` accepts matching inside a fenced code block it would
 * never actually reach.
 */
export function hasFootnoteDefOpener(text: string): boolean {
  if (text.includes('[^') === false) return false;
  return new RegExp(HEADER_RE.source, 'm').test(text);
}

/**
 * The two extensions, in the order they are registered.
 *
 * ## Neither supplies `start()`, and the block one must not
 *
 * `start()` is not the harmless optimisation it looks like. `Lexer.blockTokens`
 * clips the text handed to the paragraph tokenizer whenever any extension's
 * `startBlock` hook reports a position, and sets a flag that merges the *next*
 * paragraph into the clipped one — so a `[^` anywhere ahead retroactively
 * re-groups paragraphs already emitted.
 *
 * Measured against marked 18.0.7 on `incrementalLex.ts`'s own probe string,
 * `'Term\n: definition-ish\n| partial | table |\n| --- |\n\nAfter.\n'` followed
 * by `'\n[^1]: n\n'`:
 *
 * - with a block `start()`: `[paragraph, space, paragraph, space, footnoteDef]`
 *   — four content tokens collapse to three and the `Term` paragraph is **lost**
 * - without it: `[paragraph, paragraph, space, paragraph, space, footnoteDef]`,
 *   identical to the no-extension baseline
 *
 * It also breaks the invariant every incremental offset is derived from — that
 * the tokens' `raw` strings tile their source. With a block `start()`,
 * `'A[^1] B[^2].\n\n[^1]: One.\n[^2]: Two.\n'` yields a paragraph whose `raw` is
 * `'A\n[^1] B[^2].'`: a newline the source does not contain. A 2x2 matrix over
 * (block `start()`, inline `start()`) attributes both symptoms to the block one
 * alone.
 *
 * The inline `start()` is simply not load-bearing — with and without it the
 * inline token sequence is identical — so it is omitted for the smaller surface.
 *
 * Omitting the block `start()` costs one spec-adjacent behaviour, and it is the
 * behaviour that is already correct: a definition on the line directly after a
 * paragraph line, with no blank line between, is absorbed into that paragraph.
 * CommonMark says the same of link reference definitions (they cannot interrupt
 * a paragraph) and GFM says it of footnote definitions.
 *
 * ## Why an extension is enough
 *
 * A `marked.use` extension **runs before** the built-in tokenizers, not after:
 * `Lexer.blockTokens` and `Lexer.inlineTokens` both begin with
 * `this.options.extensions?.<level>?.some(...)`, and `Marked.use` inserts with
 * `unshift`. So `footnoteRef` claims `[^1]` ahead of the built-in `link` rule
 * and `footnoteDef` claims the definition line ahead of the `def` rule. Both are
 * necessary. Without them, marked 18.0.7 splits on whether the note body
 * contains a space, because a link destination cannot:
 *
 * - `[^1]: The note.` → `[paragraph, space, paragraph]`, the definition showing
 *   as a stray body paragraph and `Here[^1] is text.` printing its raw syntax
 * - `[^1]: Note.` → `[paragraph, space, def]`, where the reference becomes a
 *   real inline `link` with `href: 'Note.'` — a **clickable link to a garbage
 *   URL** — and the definition line vanishes from the output entirely
 *
 * A test written only against the first case passes while the second still ships.
 *
 * Claiming the definition before the `def` rule has a second effect worth
 * naming: `tokens.links` stays empty, so a footnoted document no longer trips
 * the permanent `'link-definition'` degrade in `incrementalLex.ts`.
 *
 * ## `renderer` is required but unreachable
 *
 * `marked.use` demands one for a custom token, and `@vectojs/markdown` never
 * calls `marked.parse` — it renders from the token tree. Returning `raw`
 * matches what the math extensions do, so an HTML round-trip is lossless rather
 * than silently dropping the note.
 */
export const FOOTNOTE_EXTENSIONS: TokenizerAndRendererExtension[] = [
  {
    name: 'footnoteRef',
    level: 'inline',
    tokenizer(src) {
      const match = REF_RE.exec(src);
      if (match) {
        return {
          type: 'footnoteRef',
          raw: match[0],
          label: match[1],
        } satisfies FootnoteRefToken;
      }
      return undefined;
    },
    renderer(token) {
      return token.raw;
    },
  },
  {
    name: 'footnoteDef',
    level: 'block',
    tokenizer(src) {
      const header = HEADER_RE.exec(src);
      if (!header) return undefined;
      const rest = src.slice(header[0].length);
      const cont = consumeContinuation(rest);
      // `this.lexer.blockTokens` is the same recursion `container`'s tokenizer
      // uses to reach nested block content through the SAME extension set,
      // rather than a hand-rolled sub-lex — see that module's doc comment for
      // why reaching through `this` rather than the module-level `marked`
      // import matters. Only called when there is real continuation content:
      // an all-blank tail (see `consumeContinuation`) has nothing to lex.
      const tokens: Token[] = cont.body.trim() ? this.lexer.blockTokens(cont.body, []) : [];
      return {
        type: 'footnoteDef',
        raw: header[0] + cont.raw,
        label: header[1],
        body: header[2],
        tokens,
      } satisfies FootnoteDefToken;
    },
    renderer(token) {
      return token.raw;
    },
  },
];

/**
 * The visible marker for a label: `1` → `[1]`.
 *
 * Brackets rather than a raised superscript because {@link TextStyle} has no
 * baseline shift, and `InlineObjectSurface` exposes only `drawImage` — so a
 * genuinely raised marker would mean rasterizing text, at a cost far past what a
 * reference marker is worth. Size alone carries the signal instead
 * (`theme.footnoteMarkerScale`).
 *
 * Unicode superscript digits (`¹`) were the obvious alternative and are wrong
 * here: they exist only for digits, so `[^note]` could not use them, and a
 * document mixing numeric and named labels would render two different marker
 * styles. Font coverage for the full set is also uneven.
 *
 * The `^` is dropped — `[^1]` is source syntax, `[1]` is the conventional
 * printed marker — and the label is printed **as written** rather than
 * renumbered to GFM's 1, 2, 3 by order of first reference. Renumbering needs
 * document-wide state, which is exactly the non-local dependency that makes
 * incremental lexing unsound: a reference arriving late would renumber markers
 * already on screen. incremark reaches the same conclusion from the other
 * direction, patching micromark to stop checking whether a definition exists so
 * a reference can parse before its definition arrives.
 */
export function footnoteMarker(label: string): string {
  return `[${label}]`;
}
