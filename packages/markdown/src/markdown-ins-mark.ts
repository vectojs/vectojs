import type { TokenizerAndRendererExtension } from 'marked';

/**
 * `markdown-it`-style insert and highlight: `++inserted++`, `==marked==`.
 *
 * Two new `marked.use` inline extensions, the same shape as
 * `markdown-superscript.ts`'s `sup`: neither `+` nor `==` is tokenized by
 * marked's built-in grammar at all (verified against marked@18.0.7 — both fall
 * through to plain `text`, `PX-0524`), so each needs its own tokenizer rather
 * than reusing an existing token type the way single-tilde subscript reuses
 * `del`.
 *
 * Registered in `Markdown.ts` and `MarkdownWorker.ts` from this single shared
 * array, for the reason `markdown-footnote.ts` gives at length: the two lexers
 * must agree exactly, or the worker emits tokens the renderer has no arm for.
 *
 * Deliberately holds no entity, theme or `@vectojs/*` import, so this module
 * stays safe to inline into the worker bundle (`scripts/build-worker.js`,
 * `bundle: true`).
 */

/** `++content++`, as it appears mid-sentence. See `SuperscriptToken` for why
 *  this carries `text` rather than a distinct field name. */
export interface InsToken {
  type: 'ins';
  raw: string;
  text: string;
}

/** `==content==`, as it appears mid-sentence. */
export interface MarkToken {
  type: 'mark';
  raw: string;
  text: string;
}

/**
 * `++content++`: two plusses, then content that neither starts nor ends with
 * whitespace and contains no un-escaped `++`, then two closing plusses.
 *
 * NOT the same content class as `SUP_RE`: superscript excludes a bare `^`
 * entirely because `19^th^` wraps a single word, but `++inserted text++`
 * must allow internal spaces the way `~~struck text~~` does — so this
 * excludes only the closing DELIMITER `++` (via a negative lookahead per
 * character, non-greedy `+?`), not bare `+` itself (`++a+b++` is valid, one
 * span, content `a+b`). The no-leading/trailing-whitespace lookarounds are
 * what keep `++not closed` and `a ++ b` as plain prose, matching
 * `markdown-it-ins`.
 *
 * Excluding `++` from the middle (rather than excluding whitespace-adjacent
 * `+` only) is what makes `a++b++++c++d` resolve as two independent adjacent
 * spans (`b`, `c`) instead of one greedy span from the first delimiter to the
 * last: non-greedy `+?` stops at the FIRST `++` it can, so `++b++` closes
 * immediately rather than treating the middle `++` as content and skipping to
 * the final one. Verified against marked@18.0.7 the same way `SUP_RE`'s doc
 * comment records for `^`.
 */
const INS_RE = /^\+\+(?!\s)((?:\\[\s\S]|(?!\+\+)[\s\S])+?)(?<!\s)\+\+/;

/** `==content==`: identical shape to `INS_RE`, delimited by `=` instead of `+`. */
const MARK_RE = /^==(?!\s)((?:\\[\s\S]|(?!==)[\s\S])+?)(?<!\s)==/;

export const INS_MARK_EXTENSIONS: TokenizerAndRendererExtension[] = [
  {
    name: 'ins',
    level: 'inline',
    // Without `start()`, marked's plain-text fallback tokenizer (`inlineText`)
    // never stops at `+` — see `markdown-superscript.ts`'s identical note for
    // `^`, which applies here verbatim.
    start(src) {
      return src.match(/(?<!\\)\+\+(?!\s)/)?.index;
    },
    tokenizer(src) {
      const match = INS_RE.exec(src);
      if (match) {
        return {
          type: 'ins',
          raw: match[0],
          // Unescape `\x` -> `x`, the same reason `SUP_RE`'s tokenizer does:
          // `collectSpans`' `decodeEntities` only resolves HTML entities, not
          // backslash escapes.
          text: match[1].replace(/\\(.)/g, '$1'),
        } satisfies InsToken;
      }
      return undefined;
    },
    renderer(token) {
      return token.raw;
    },
  },
  {
    name: 'mark',
    level: 'inline',
    start(src) {
      return src.match(/(?<!\\)==(?!\s)/)?.index;
    },
    tokenizer(src) {
      const match = MARK_RE.exec(src);
      if (match) {
        return {
          type: 'mark',
          raw: match[0],
          text: match[1].replace(/\\(.)/g, '$1'),
        } satisfies MarkToken;
      }
      return undefined;
    },
    renderer(token) {
      return token.raw;
    },
  },
];
