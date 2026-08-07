import type { TokenizerAndRendererExtension } from 'marked';

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

/** A footnote definition line — `[^1]: The note.` — as its own block. */
export interface FootnoteDefToken {
  type: 'footnoteDef';
  raw: string;
  /** The label exactly as written, matching a {@link FootnoteRefToken}'s. */
  label: string;
  /** The note body, source text with inline markup left unparsed. */
  body: string;
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
 * `[^label]: body` on one line, with up to three spaces of indent.
 *
 * **Single-line only, and the trailing continuation lines GFM allows are
 * deliberately not consumed.** A tokenizer that could span a blank line reaches
 * arbitrarily far ahead of its own token, which is precisely the property that
 * forces `incrementalLex.ts` to degrade an instance outright when it sees a
 * line-start `$$` (see the `hasBlockMathOpener` note there). Footnotes are
 * common in streamed prose, so permanently disabling incremental lexing for any
 * document containing one would be a far worse trade than dropping indented
 * continuation lines — which are rare, and which still render, as the ordinary
 * indented-code or paragraph blocks `marked` already makes of them.
 */
const DEF_RE = new RegExp(`^ {0,3}\\[\\^${LABEL}\\]:[ \\t]*([^\\n]*)(?:\\n|$)`);

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
      const match = DEF_RE.exec(src);
      if (match) {
        return {
          type: 'footnoteDef',
          raw: match[0],
          label: match[1],
          body: match[2],
        } satisfies FootnoteDefToken;
      }
      return undefined;
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
