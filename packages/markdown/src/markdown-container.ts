import type { Token, TokenizerAndRendererExtension } from 'marked';

/**
 * `:::` fenced containers (`:::note … :::`, `:::warning … :::`), the
 * `remark-directive`/`markdown-it-container` construct.
 *
 * One new `marked.use` **block** extension. Nothing in `marked`'s grammar,
 * including GFM, tokenizes a `:::` fence at all — verified against
 * marked@18.0.7: it falls through to plain `paragraph`/`text` (`PX-0524`).
 *
 * Registered in `Markdown.ts` and `MarkdownWorker.ts` from this single shared
 * array, for the reason `markdown-footnote.ts` gives at length: the two
 * lexers must agree exactly, or the worker emits tokens the renderer has no
 * arm for.
 *
 * Deliberately holds no entity, theme or `@vectojs/*` import, so this module
 * stays safe to inline into the worker bundle (`scripts/build-worker.js`,
 * `bundle: true`).
 */

/** A `:::kind\n…body…\n:::` block, its body block-lexed like a blockquote's. */
export interface ContainerToken {
  type: 'container';
  raw: string;
  /**
   * The word after `:::` on the opening line, e.g. `'note'`. `undefined` for
   * a bare `:::` with nothing after it — a container with no declared kind
   * still fences its content, it just has no theme-mapped colour or label.
   */
  kind?: string;
  /** Nested block tokens, exactly as `blockquote`'s `tokens` field. */
  tokens: Token[];
}

/**
 * `:::name` (word characters only — the kind is a fixed vocabulary of style
 * names, not free text) or a bare `:::`, at the start of a line.
 */
const OPEN_RE = /^ {0,3}:::([A-Za-z][\w-]*)?[ \t]*(?:\n|$)/;

/** Either fence form, at the start of a line: opener (group 1) or bare close. */
const FENCE_LINE_RE = /^ {0,3}:::([A-Za-z][\w-]*)?[ \t]*$/;

/**
 * Find the end of the OUTERMOST container's body, honouring nesting depth.
 *
 * A bare depth-1 search (find the next line matching `:::`) is wrong the
 * moment a container nests: `:::outer\n:::inner\ntext\n:::\n:::` would close
 * `outer` at `inner`'s own closing fence, three lines too early, and leave a
 * dangling final `:::` to render as a stray paragraph. Verified empirically
 * against a depth-1 implementation before this one replaced it.
 *
 * Scans line by line, tracking depth, rather than a single regex search: an opening
 * fence (`:::name` or bare `:::` immediately followed by non-fence content)
 * increments depth, and a line matching `:::` alone decrements it — but a
 * line is only an opener if it is not itself already balanced by an
 * immediately-following close on a LATER line at the same depth, which is
 * exactly what the running counter tracks. Returns the character offset just
 * past the body (i.e. where the closing fence line starts), or `-1` if the
 * fence never closes.
 */
function findBodyEnd(text: string): number {
  let depth = 1;
  let offset = 0;
  while (offset < text.length) {
    const lineEnd = text.indexOf('\n', offset);
    const line = lineEnd === -1 ? text.slice(offset) : text.slice(offset, lineEnd);
    const match = FENCE_LINE_RE.exec(line);
    if (match) {
      if (match[1] !== undefined) {
        // `:::name` — an opener, even nested. A bare `:::` with a name is
        // never a closer, so this always increments.
        depth++;
      } else {
        // A bare `:::` — this line closes whatever the innermost open fence
        // is, which is `depth`'s current value.
        depth--;
        if (depth === 0) return offset;
      }
    }
    if (lineEnd === -1) break;
    offset = lineEnd + 1;
  }
  return -1;
}

/**
 * The two extensions, in the order they are registered.
 *
 * ## No `start()`, for the same reason `footnoteDef` has none
 *
 * A block `start()` clips the text handed to the paragraph tokenizer and
 * retroactively re-groups an already-emitted paragraph the moment a `:::`
 * appears anywhere ahead — `markdown-footnote.ts`'s doc comment measures this
 * exhaustively for `[^`, and the same `Lexer.blockTokens` mechanism applies
 * here verbatim. Omitting it costs the same one CommonMark-adjacent
 * behaviour footnotes already give up: a fence written directly after a
 * paragraph line, with no blank line between, is absorbed into that
 * paragraph instead of opening a container. Verified empirically against
 * marked@18.0.7.
 *
 * ## The forward-reach hazard this construct DOES have
 *
 * Unlike `footnoteDef` (single-line, cannot reach past its own token) but
 * LIKE `blockMath`, an unterminated `:::` opener can absorb arbitrarily much
 * of the document once its closing fence eventually arrives — the tokenizer
 * below scans forward for a depth-balanced close with no bound on how far. Measured: a
 * prefix ending in an open `:::note\nHello` block-lexes to
 * `[paragraph, space, paragraph]` (an ordinary unterminated-fence-reads-as-
 * text fallback), and appending `\n\nWorld\n:::\n` collapses ALL of it into a
 * single `container` token whose nested tokens are `[paragraph('Hello'),
 * space, paragraph('World')]` — the same shape `blockMath`'s doc comment
 * documents for `$$`. `incrementalLex.ts`'s `hasContainerOpener()` therefore
 * degrades an instance the same way `hasBlockMathOpener()` does, using the
 * same `OPEN_RE` this module exports for that check to share the exact
 * definition of "a fence is open" with the tokenizer.
 *
 * ## Why an extension is enough
 *
 * `marked.use` extensions run BEFORE the built-in tokenizers (`Lexer.use`
 * inserts with `unshift`), so `container` claims the `:::` line ahead of the
 * built-in `paragraph`/`text` rules — the same ordering `footnoteRef`/
 * `footnoteDef` rely on, contradicting the earlier (wrong) assumption
 * recorded in `PX-0517`/`DEC-01KZDGBE`.
 *
 * ## `renderer` is required but unreachable
 *
 * `marked.use` demands one for a custom token, and `@vectojs/markdown` never
 * calls `marked.parse` — it renders from the token tree. Returning `raw`
 * matches every other extension in this package.
 */
export const CONTAINER_EXTENSIONS: TokenizerAndRendererExtension[] = [
  {
    name: 'container',
    level: 'block',
    tokenizer(src) {
      const open = OPEN_RE.exec(src);
      if (!open) return undefined;
      const afterOpen = src.slice(open[0].length);
      const bodyEnd = findBodyEnd(afterOpen);
      if (bodyEnd < 0) return undefined;
      const body = afterOpen.slice(0, bodyEnd);
      // The closing fence line itself: from `bodyEnd` to its own line end
      // (or end of string), plus the trailing newline if one follows.
      const closeLineEnd = afterOpen.indexOf('\n', bodyEnd);
      const closeEnd = closeLineEnd === -1 ? afterOpen.length : closeLineEnd + 1;
      const raw = open[0] + afterOpen.slice(0, closeEnd);
      // `this.lexer.blockTokens` is what `blockquote` itself uses to recurse
      // into nested block content — bold, lists, nested containers — rather
      // than a hand-rolled sub-lex. Reaching through `this` (not the module-
      // level `marked` import) is deliberate: the lexer instance carries the
      // extensions this VERY registration is part of, so a container nested
      // inside a container recurses through the same extension set rather
      // than a default one that would not recognise `:::` at all.
      const tokens = this.lexer.blockTokens(body, []);
      return {
        type: 'container',
        raw,
        kind: open[1],
        tokens,
      } satisfies ContainerToken;
    },
    renderer(token) {
      return token.raw;
    },
  },
];

/** Whether `text` contains a `:::` opener that {@link OPEN_RE} would match. */
export function hasContainerOpener(text: string): boolean {
  // Cheap reject first: the overwhelmingly common chunk has no `:::` at all,
  // and this runs on every streamed chunk (mirrors `hasBlockMathOpener`).
  if (text.includes(':::') === false) return false;
  return new RegExp(OPEN_RE.source, 'm').test(text);
}
