import type { TokenizerAndRendererExtension } from 'marked';

/**
 * `markdown-it`-style superscript: `19^th^`, `x^2^`.
 *
 * A new `marked.use` inline extension, unlike subscript — single-tilde already
 * lexed to a real token (`del`) that `collectSpans` merely had to recognise by
 * `raw`. Nothing in `marked`'s built-in grammar produces a token for `^…^` at
 * all: it falls through to plain `text`, verified against marked@18.0.7 in
 * `PX-0524`. So superscript needs its own tokenizer, the same shape as
 * `markdown-footnote.ts`'s `footnoteRef`.
 *
 * Registered in `Markdown.ts` and `MarkdownWorker.ts` from this single shared
 * array, for the reason `markdown-footnote.ts` gives at length: the two lexers
 * must agree exactly, or the worker emits tokens the renderer has no arm for.
 *
 * Deliberately holds no entity, theme or `@vectojs/*` import, so this module
 * stays safe to inline into the worker bundle (`scripts/build-worker.js`,
 * `bundle: true`).
 */

/**
 * `^content^`, as it appears mid-sentence.
 *
 * Carries `text` rather than a distinct field name — unlike
 * {@link import('./markdown-footnote').FootnoteRefToken}, which avoids `text`
 * so an unhandled token falls through to nothing rather than to a wrong
 * render. A superscript token IS mostly text, just raised: `producesEntity`'s
 * `'text' in token` fallback rendering it as an ordinary block if this arm were
 * ever missing is a reasonable enough degradation (plain, unraised text) that
 * the distinct-name defence footnotes need does not apply here.
 */
export interface SuperscriptToken {
  type: 'sup';
  raw: string;
  text: string;
}

/**
 * `^content^`: the caret, one or more characters that are neither whitespace
 * nor an unescaped caret, then a closing caret.
 *
 * No whitespace inside, matching `markdown-it-sup` and CommonMark-adjacent
 * inline-extension conventions generally: `^not closed` and `a ^ b` must stay
 * plain prose, since a superscript spanning a sentence would raise the entire
 * rest of the paragraph, which no author intends. Excluding a bare `^` from the
 * content (an escaped `\^` is fine) is what stops the match from skipping past
 * an intervening pair to close against a caret further down the line: with a
 * bare `^` allowed as content, `a^b^^c^d` would greedily span from the first
 * caret to the LAST, superscripting `b^^c` whole. Excluding it instead lets
 * each `^…^` resolve independently left to right — verified against
 * marked@18.0.7: `a^b^^c^d` tokenizes as `text('a')`, `sup('b')`, `sup('c')`,
 * `text('d')`, the same greedy-independent-pairs behaviour `**a** **b**` gets
 * from the built-in `strong` tokenizer.
 */
const SUP_RE = /^\^((?:\\[\s\S]|[^\s^\\])+)\^/;

export const SUPERSCRIPT_EXTENSIONS: TokenizerAndRendererExtension[] = [
  {
    name: 'sup',
    level: 'inline',
    // Without `start()`, marked's plain-text fallback tokenizer (`inlineText`)
    // never stops at `^` — it is not one of the characters its own regex treats
    // as a boundary, unlike `[` (link) or `` ` `` (codespan) — so it swallows an
    // entire `19^th^ century` as one `text` token before this extension is ever
    // tried at the right offset. `inlineMath` hits the identical problem for `$`
    // and solves it the same way; verified against marked@18.0.7 that inline
    // `start()` only clips the span handed to `inlineText`, not paragraph
    // grouping — the hazard `DEC-01KZDGCP` documents is specific to a *block*
    // `start()` retroactively re-grouping paragraphs, which does not apply here.
    start(src) {
      return src.match(/(?<!\\)\^(?!\s)/)?.index;
    },
    tokenizer(src) {
      const match = SUP_RE.exec(src);
      if (match) {
        return {
          type: 'sup',
          raw: match[0],
          // Unescape `\x` -> `x` for any character (the content regex admits
          // `\` followed by anything) so `x^a\^b^` carries a literal caret
          // rather than a visible backslash. `collectSpans`' `decodeEntities`
          // only handles HTML entities, not backslash escapes, so this token
          // resolves its own before `text` is set.
          text: match[1].replace(/\\(.)/g, '$1'),
        } satisfies SuperscriptToken;
      }
      return undefined;
    },
    renderer(token) {
      return token.raw;
    },
  },
];
