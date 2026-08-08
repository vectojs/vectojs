import type { TokenizerAndRendererExtension, Token } from 'marked';

/**
 * `markdown-it-abbr`-style abbreviations: `*[HTML]: HyperText Markup Language`
 * defines a term, and every later whole-word occurrence of `HTML` in the
 * document's prose gets a dotted-underline visual treatment.
 *
 * This is architecturally unlike every other `PX-0524` span construct. Every
 * other one (`sub`, `sup`, `ins`, `mark`, `emoji`) is a token-level
 * substitution: the tokenizer sees the construct's own delimiters and emits a
 * styled span right there. An abbreviation definition carries no delimiters at
 * its use site at all — `HTML` in `The HTML spec` is indistinguishable from
 * any other word until the WHOLE document's definitions are known. So this
 * module only collects the dictionary; applying it to prose is
 * `markdown-inline.ts`'s `emitProse` job, which every `collectSpans` leaf now
 * routes through instead of pushing a bare span.
 *
 * ## Why this forces a full-document re-render on change
 *
 * A definition can be written anywhere — GFM allows it inline, but the
 * convention (and this module's only shape) is one line, and streamed
 * documents commonly put them at the end, same as footnotes. If a definition
 * arrives in the incremental-lex TAIL while the term it defines already
 * rendered in the STABLE PREFIX, the prefix's paragraph entities were built by
 * `collectSpans` before the dictionary contained that term, and `Markdown.ts`'s
 * `updateTokens` reuses an entity whenever its token's `raw` is byte-identical
 * — which it is, since the term's OWN paragraph did not change, only a
 * definition elsewhere did. This is exactly `hasLinkDefinitions`'s own
 * problem (a reference definition arriving late must retroactively change
 * already-rendered inline tokens) and gets the same fix at the same layer:
 * `Markdown.ts` tracks the resolved dictionary across renders and forces a full
 * rebuild — not merely a full re-LEX, which `incrementalLex.ts` already gets
 * right regardless — whenever it changes. See `Markdown.ts`'s
 * `abbreviationsChanged` check next to `updateTokens`.
 */

/** `*[TERM]: definition` — collected metadata, not rendered content. */
export interface AbbrDefToken {
  type: 'abbrDef';
  raw: string;
  /** The term exactly as written between `*[` and `]`, e.g. `HTML`. */
  term: string;
  /** The definition text, shown as the term's tooltip title in prose. */
  definition: string;
}

/**
 * `*[term]: definition` on one line, up to three spaces of indent.
 *
 * **Single-line only**, for the identical reason `markdown-footnote.ts`'s
 * `DEF_RE` is: a tokenizer whose match can span a blank line reaches
 * arbitrarily far ahead of its own token, which is the property that forces an
 * `incrementalLex.ts` instance to degrade outright rather than merely capping
 * its boundary (see `hasBlockMathOpener`'s note there). A continuation line is
 * rare enough for an abbreviation definition that dropping it (it becomes an
 * ordinary paragraph, still visible, just not merged into the definition) is a
 * far better trade than disabling incremental lexing for every document that
 * defines one.
 *
 * The term excludes `]` and newlines but is otherwise permissive — a term can
 * be a multi-word phrase (`*[JS Engine]: JavaScript execution engine`), since
 * markdown-it-abbr itself allows this and `emitProse`'s whole-phrase matching
 * handles a space in the term the same way it handles one in ordinary prose.
 */
const DEF_RE = /^ {0,3}\*\[([^\]\n]+)\]:[ \t]*([^\n]*)(?:\n|$)/;

/**
 * The single `marked.use` block extension, shared between `Markdown.ts` and
 * `MarkdownWorker.ts` — same lockstep requirement `markdown-footnote.ts`
 * documents at length: the two lexers must agree exactly.
 *
 * No `start()`, for the same reason `footnoteDef` supplies none: a block
 * `start()` retroactively re-groups paragraphs already emitted (see
 * `markdown-footnote.ts`'s measured evidence). Its absence costs the same one
 * spec-adjacent behaviour footnotes already accept — a definition on the line
 * directly after a paragraph with no blank line between is absorbed into that
 * paragraph rather than recognised.
 */
export const ABBR_EXTENSIONS: TokenizerAndRendererExtension[] = [
  {
    name: 'abbrDef',
    level: 'block',
    tokenizer(src) {
      const match = DEF_RE.exec(src);
      if (match) {
        return {
          type: 'abbrDef',
          raw: match[0],
          term: match[1],
          definition: match[2],
        } satisfies AbbrDefToken;
      }
      return undefined;
    },
    renderer(token) {
      return token.raw;
    },
  },
];

/**
 * Whether `text` contains an abbreviation-definition line at all.
 *
 * Cheap reject first (`*[` is rare outside this construct), matching every
 * other opener-detector in this package (`hasBlockMathOpener`,
 * `hasContainerOpener`).
 */
export function hasAbbrDef(text: string): boolean {
  if (text.includes('*[') === false) return false;
  return new RegExp(DEF_RE.source, 'm').test(text);
}

/**
 * Scan top-level tokens for `abbrDef` entries and build the term dictionary.
 *
 * Later definitions of the same term win — the same "last write wins" rule
 * `marked` itself applies to duplicate link reference definitions — rather
 * than throwing or silently keeping the first, since a streamed document has
 * no way to reject a correction after the fact.
 */
export function collectAbbreviations(tokens: readonly Token[]): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const token of tokens) {
    if (token.type === 'abbrDef') {
      const t = token as AbbrDefToken;
      map.set(t.term, t.definition);
    }
  }
  return map;
}
