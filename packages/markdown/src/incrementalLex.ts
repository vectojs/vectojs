/**
 * Incremental block lexing for a growing (append-only) Markdown source.
 *
 * ## The problem this solves
 *
 * `marked` has no incremental lexing API, so the obvious streaming strategy is
 * to re-lex the whole accumulated document on every chunk. That is O(n²) over a
 * stream, and measured in `comparisons/stream-markdown-smd` it dominates
 * everything else: a 25 070-char document delivered in 784 chunks cost 434 ms in
 * Chrome 150 while lexing the finished document **once** cost 0.975 ms. The
 * parser is linear; the strategy was quadratic.
 *
 * This module keeps a **stable block boundary** — a character offset before
 * which the token list can no longer change — and re-lexes only the text after
 * it, splicing the result onto the already-stable token prefix. The cost per
 * chunk becomes O(unstable tail) instead of O(document).
 *
 * ## The correctness contract
 *
 * {@link lexFull} and {@link lexAppend} must return a token list **deeply
 * identical** to `marked.lexer(source)` for the same source. Speed is
 * secondary: a boundary chosen one line too early silently corrupts the token
 * stream, which is a far worse failure than being slow. `incrementalLex.test.ts`
 * enforces this by streaming a corpus one character at a time and comparing
 * against a full lex at **every** intermediate length.
 *
 * ## Why the boundary rule is what it is
 *
 * The rule: cut immediately after a `space` token that has **at least one token
 * following it**, and never when a link reference definition exists.
 *
 * Three properties of `marked`'s block lexer (18.0.7) make that safe, and each
 * was measured exhaustively rather than reasoned about:
 *
 * 1. **A pushed `space` token always means a blank line.** A lone `\n` is merged
 *    into the preceding token's `raw` instead of being pushed, so a `space`
 *    token in the list is a real block separator — never a single line ending.
 * 2. **For every built-in rule, only the token adjacent to the end of the source
 *    can still change.** With a token following the `space`, the construct
 *    before that `space` is committed. This is what rules out the interesting
 *    failures: an indented code block or a loose list *can* absorb a blank line
 *    and keep going, and a `paragraph` can still acquire a setext underline —
 *    but only while it is the last thing in the source. A brute-force sweep over
 *    14 documents × every prefix length × every cut index found the
 *    `nFollow >= 1` form safe for every predecessor type (`blockquote`, `code`,
 *    `heading`, `hr`, `html`, `list`, `paragraph`, `table`) and the
 *    `nFollow == 0` form unsafe for `code`, `list` and `paragraph` — hence the
 *    one-token lag.
 *
 *    Two things break that property, and both were found by fuzzing rather than
 *    by reading the rules:
 *
 *    **A `list` reaches past a blank line to absorb a following list item.**
 *    Measured: `'1. ordered\n2. second\n\n\n1.'` is a *single* `list` token with
 *    `loose: true`, where a splice at the blank line yields
 *    `[list(loose:false), space, list]`. Three tokens against one, and the
 *    `loose` flag differs, which changes rendering. So a cut whose next token is
 *    a `list` is only taken once a *further* token exists after it — at which
 *    point the list can no longer grow. This is {@link cutIsSettled}.
 *
 *    **Our own `blockMath` extension breaks locality in both directions**, which
 *    is why {@link hasBlockMathOpener} degrades outright:
 *    - *Forward*: the tokenizer is `/^ {0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/`
 *      and `[\s\S]+?` crosses blank lines, so an unterminated `$$` reaches
 *      arbitrarily far ahead. Measured: `'$$\nopen\n\npara\n'` lexes to
 *      `[paragraph, space, paragraph]`, and appending `'\n$$\n'` collapses all
 *      three into one `blockMath` token.
 *    - *Backward*: `blockTokens` clips the text handed to the paragraph
 *      tokenizer whenever an extension's `startBlock` hook reports a position,
 *      and sets a flag that merges the **next** paragraph into the clipped one.
 *      Since `blockMath` supplies `start()`, a `$$` anywhere ahead retroactively
 *      re-groups paragraphs already emitted. Measured on
 *      `'Term\n: definition-ish\n| partial | table |\n| --- |\n\nAfter.\n'`
 *      plus a trailing `'\n$$\nx\n'`: without the extension it is
 *      `paragraph, paragraph`; with it registered the two become **one** merged
 *      paragraph. Capping the boundary cannot fix a backwards reach, so any
 *      line-start `$$` degrades the instance instead. That is only correct
 *      because `start()` returns `undefined` when no line-start `$$` exists, so
 *      with none present the clip never fires and the merge is impossible.
 *
 *    Any future block-level extension that supplies `start()` or whose tokenizer
 *    can span a blank line needs the same treatment.
 *
 *    **`footnoteDef`'s continuation-consuming tokenizer has the identical
 *    forward-reach shape**, added when it grew from single-line-only to
 *    supporting indented multi-paragraph bodies: `consumeContinuation` in
 *    `markdown-footnote.ts` scans forward through blank-line runs looking for
 *    an indented line, exactly as `blockMath`'s regex crosses them. It supplies
 *    no `start()` (so the backward-reach half of `blockMath`'s hazard does not
 *    apply), but the forward half does, so `hasFootnoteDefOpener` degrades the
 *    instance the same way `hasBlockMathOpener`/`hasContainerOpener` do.
 * 3. **Link reference definitions break prefix reuse entirely.** `marked`
 *    collects every `def` while block-lexing and only then resolves reflinks
 *    across the *whole* document, so a definition arriving late retroactively
 *    changes inline tokens that are already emitted, and one inside the stable
 *    prefix is invisible to a suffix lex. Both directions are unfixable by
 *    boundary placement, so an instance that sees any definition degrades to
 *    full lexing permanently. The sweep confirms it: `def` was the one
 *    predecessor type unsafe at `nFollow >= 1` (21/21).
 *
 * Degrading is always available and always correct, so a carriage return takes
 * it: `marked` normalises CR internally, which desyncs every raw-length offset
 * from the source those offsets are supposed to index.
 *
 * ## Why the boundary is verified rather than trusted
 *
 * Offsets are derived by summing `raw` lengths, which assumes `raw` strings tile
 * their source. They usually do, but not always: measured against marked 18.0.7,
 * a source ending in a bare list marker (`"- a\n- "`) lexes to raw `"- a\n-\n"`,
 * because the list tokenizer trims the final item and re-adds a newline. So
 * every advance is **verified** — the text being declared stable must equal the
 * concatenated `raw` of the tokens covering it — and an advance that fails
 * verification is simply not taken. That case is transient (the next chunk
 * completes the item and it tiles again), so declining costs one chunk of window
 * growth, where degrading would have cost the whole rest of the stream.
 */
import { marked, type Token, type TokensList } from 'marked';
import { hasContainerOpener } from './markdown-container';
import { hasFootnoteDefOpener } from './markdown-footnote';

/**
 * Everything needed to extend a lex without redoing it.
 *
 * `source` and `tail` are both carried because they serve different masters:
 * `source` is what a full lex needs if this instance ever degrades (and what the
 * caller reconciles its own length check against), while `tail` is the unstable
 * suffix that is actually re-lexed each chunk. Keeping `tail` separately is what
 * makes the per-chunk string work O(tail) — deriving it as
 * `source.slice(stableOffset)` each time would force the engine to flatten the
 * concatenation rope, putting an O(document) memcpy back into the hot path.
 */
export interface IncrementalLexCache {
  /** Full accumulated source these tokens describe. */
  readonly source: string;
  /** `source.slice(stableOffset)` — the part still subject to change. */
  readonly tail: string;
  /** Complete token list for `source`. */
  readonly tokens: TokensList;
  /** Number of leading tokens that can no longer change. */
  readonly stableCount: number;
  /** Character offset in `source` at which the stable prefix ends. */
  readonly stableOffset: number;
  /** Once set, this instance always full-lexes. Never clears. */
  readonly degraded: boolean;
  /** Why it degraded, for tests and diagnostics. `null` while incremental. */
  readonly degradedReason: DegradeReason | null;
}

/** Why an instance gave up on incremental lexing. */
export type DegradeReason =
  /** A link reference definition exists; see the module comment. */
  | 'link-definition'
  /** A carriage return desyncs `raw`-length offsets from source offsets. */
  | 'carriage-return'
  /** A line-start `$$` lets `blockMath` reach outside its own token. */
  | 'block-math'
  /** An open `:::` fence lets `container` reach outside its own token. */
  | 'container'
  /**
   * A `[^label]:` header lets `footnoteDef`'s continuation scan reach outside
   * its own token, now that it consumes indented continuation lines. See
   * `markdown-footnote.ts`'s `hasFootnoteDefOpener` doc comment.
   */
  | 'footnote-def';

export interface IncrementalLexResult {
  /** Deeply identical to `marked.lexer(source)`. */
  readonly tokens: TokensList;
  readonly cache: IncrementalLexCache;
  /**
   * Characters actually handed to `marked.lexer()`. Equal to `source.length` for
   * a full lex and to the unstable tail otherwise — so the ratio against the
   * document length is the direct measure of what the boundary saved.
   */
  readonly charsLexed: number;
  /** Leading tokens taken from the cache rather than re-lexed. */
  readonly reusedTokens: number;
}

/** Sum of `raw` lengths over a token range. */
function sumRaw(tokens: readonly Token[], from: number, to: number): number {
  let total = 0;
  for (let i = from; i < to; i++) total += tokens[i]!.raw.length;
  return total;
}

/**
 * A `TokensList` is a `Token[]` carrying a `links` map. Splicing produces a
 * plain array, so the map has to be reattached deliberately.
 */
function asTokensList(tokens: Token[], links: TokensList['links']): TokensList {
  const list = tokens as TokensList;
  list.links = links;
  return list;
}

/** A `$$` at the start of a line, up to three spaces of indent. */
const BLOCK_MATH_OPEN = /^ {0,3}\$\$/m;

/**
 * Whether `text` contains a `$$` display-math opener at the start of a line.
 *
 * This is exactly the condition under which `blockMath`'s `start()` hook returns
 * a position, and therefore exactly the condition under which the extension can
 * reach outside its own token — forwards through an unterminated `$$`, and
 * backwards through marked's `startBlock` paragraph clip. See the module comment.
 * Either reach invalidates a stable prefix, so its presence degrades the instance
 * rather than merely capping the boundary.
 *
 * Deliberately over-conservative: it matches line-start `$$` inside fenced code,
 * where the tokenizer would never reach it — but so does the extension's own
 * `start()` hook, so this is no more conservative than marked itself.
 */
function hasBlockMathOpener(text: string): boolean {
  // Cheap reject first: the overwhelmingly common chunk has no `$` at all, and
  // this runs on every streamed chunk.
  if (text.includes('$$') === false) return false;
  return BLOCK_MATH_OPEN.test(text);
}

/**
 * Whether a cut at `at` — immediately after the `space` token at `at - 1` — is
 * settled, meaning no appended text can reach across it.
 *
 * The one-token lag settles every block type except `list`, which continues
 * across blank lines. Measured: `'- a\n\n- b\n'` is a **single** `list` token no
 * matter how many blank lines separate the items, and `'- a\n\n\n\n- b\n'` is too.
 * `[list, space, list]` only occurs when the markers are *incompatible*
 * (`- ` vs `* `, `1.` vs `1)`, bullet vs ordered) — with the same marker they
 * always merge.
 *
 * So a list before the `space` is only settled once the token after the `space`
 * is itself settled — i.e. has a further token after it, proving it will not grow
 * into a list item that the earlier list would then absorb. That is what the
 * fuzzer caught: the cut was banked while `tokens[at]` was still the paragraph
 * `'1'`, which became the list `'1. ordered'` one chunk later and merged
 * backwards.
 */
function cutIsSettled(tokens: readonly Token[], at: number): boolean {
  if (tokens[at - 2]?.type !== 'list') return true;
  return at + 1 < tokens.length;
}

/**
 * The last cut index that appended text can never invalidate, or `-1`.
 *
 * Scans backwards for a `space` token that has at least one token after it, and
 * returns the index just past it. `minCut` keeps the boundary monotonic — a cut
 * at or before the current one is not progress, and re-lexing text that is
 * already stable is the very thing this exists to avoid.
 */
function findStableCut(tokens: readonly Token[], minCut: number): number {
  // `i` is the index of the last token that would become stable, so the cut is
  // `i + 1`; starting at `length - 2` is what enforces the one-token lag.
  for (let i = tokens.length - 2; i >= minCut; i--) {
    if (tokens[i]!.type !== 'space') continue;
    if (cutIsSettled(tokens, i + 1) === false) continue;
    return i + 1;
  }
  return -1;
}

/** A `links` map with any entry means a reference definition was seen. */
function hasLinkDefinitions(list: TokensList): boolean {
  const links = list.links;
  if (!links) return false;
  for (const _key in links) return true;
  return false;
}

/**
 * Confirm that `tokens[from..to)` really do describe `text[textFrom..)`.
 *
 * The offset arithmetic assumes `raw` strings tile their source. That assumption
 * is load-bearing and not universally true (see the module comment on bare list
 * markers), so it is checked on the exact span about to be declared stable
 * rather than asserted globally. Cost is O(advance), not O(document).
 */
function advanceTiles(
  tokens: readonly Token[],
  from: number,
  to: number,
  text: string,
  textFrom: number,
): boolean {
  let at = textFrom;
  for (let i = from; i < to; i++) {
    const raw = tokens[i]!.raw;
    if (text.startsWith(raw, at) === false) return false;
    at += raw.length;
  }
  return true;
}

/** A cache that will always full-lex, for the reason given. */
function degradedCache(
  source: string,
  tokens: TokensList,
  reason: DegradeReason,
): IncrementalLexCache {
  return {
    source,
    tail: source,
    tokens,
    stableCount: 0,
    stableOffset: 0,
    degraded: true,
    degradedReason: reason,
  };
}

/** A cache with no boundary yet, still eligible to gain one. */
function unboundedCache(source: string, tokens: TokensList): IncrementalLexCache {
  return {
    source,
    tail: source,
    tokens,
    stableCount: 0,
    stableOffset: 0,
    degraded: false,
    degradedReason: null,
  };
}

/**
 * Build the cache for a completed full lex, placing a boundary if one is both
 * available and verifiable.
 */
function cacheFromFullLex(source: string, tokens: TokensList): IncrementalLexCache {
  if (hasLinkDefinitions(tokens)) return degradedCache(source, tokens, 'link-definition');
  if (source.includes('\r')) return degradedCache(source, tokens, 'carriage-return');
  if (hasBlockMathOpener(source)) return degradedCache(source, tokens, 'block-math');
  if (hasContainerOpener(source)) return degradedCache(source, tokens, 'container');
  if (hasFootnoteDefOpener(source)) return degradedCache(source, tokens, 'footnote-def');

  const cut = findStableCut(tokens, 1);
  if (cut < 0) return unboundedCache(source, tokens);
  if (advanceTiles(tokens, 0, cut, source, 0) === false) return unboundedCache(source, tokens);

  const offset = sumRaw(tokens, 0, cut);
  return {
    source,
    tail: source.slice(offset),
    tokens,
    stableCount: cut,
    stableOffset: offset,
    degraded: false,
    degradedReason: null,
  };
}

/**
 * Lex `source` from scratch and prepare to extend it incrementally.
 *
 * Used for the first request for an instance, and for anything that is not an
 * append: a `setContent()`, or a resync.
 */
export function lexFull(source: string): IncrementalLexResult {
  const tokens = marked.lexer(source);
  return {
    tokens,
    cache: cacheFromFullLex(source, tokens),
    charsLexed: source.length,
    reusedTokens: 0,
  };
}

/** Full-lex `source`, then pin the result as permanently degraded. */
function degradeTo(source: string, reason: DegradeReason): IncrementalLexResult {
  const tokens = marked.lexer(source);
  return {
    tokens,
    cache: degradedCache(source, tokens, reason),
    charsLexed: source.length,
    reusedTokens: 0,
  };
}

/**
 * Extend a previous lex with appended text, re-lexing only the unstable tail.
 *
 * The caller must guarantee `append` extends exactly `prev.source`. This does not
 * verify that, because the verification would be an O(document) comparison per
 * chunk and would defeat the purpose; the worker enforces it structurally by
 * owning the cache and by checking the caller's `expectedLength` first.
 */
export function lexAppend(prev: IncrementalLexCache, append: string): IncrementalLexResult {
  const source = prev.source + append;

  // A degraded instance stays degraded: the condition that caused it is a
  // property of text already accepted, so re-testing per chunk would only
  // re-derive the same answer at the cost of one scan.
  if (prev.degraded) return degradeTo(source, prev.degradedReason ?? 'link-definition');
  if (append.includes('\r')) return degradeTo(source, 'carriage-return');

  // No boundary has been established yet, so there is no prefix to splice onto.
  // This is not degradation — the next chunk may well produce one.
  if (prev.stableCount === 0) return lexFull(source);

  const tail = prev.tail + append;

  // Scanning the tail alone is sufficient, and is what keeps this O(window)
  // rather than O(document). `prev` is not degraded, so its source held no
  // line-start `$$`; the only new one is in `append` or straddles the junction,
  // and the tail contains both — it always includes at least the final character
  // of `prev.source`, because the boundary requires a token after the `space` and
  // every token has a non-empty `raw`. The tail also always begins at a real line
  // start (a `space` token ends with a newline), so `^` in the tail means `^` in
  // the document: no false positives, no false negatives.
  if (hasBlockMathOpener(tail)) return degradeTo(source, 'block-math');
  if (hasContainerOpener(tail)) return degradeTo(source, 'container');
  if (hasFootnoteDefOpener(tail)) return degradeTo(source, 'footnote-def');

  const suffix = marked.lexer(tail);

  // A definition anywhere forces a full lex: one in the suffix has to be able to
  // resolve reflinks in the prefix, and only a whole-document lex does that.
  if (hasLinkDefinitions(suffix)) return degradeTo(source, 'link-definition');

  const stablePrefix = prev.tokens.slice(0, prev.stableCount);
  const tokens = asTokensList([...stablePrefix, ...suffix], suffix.links);

  let stableCount = prev.stableCount;
  let stableOffset = prev.stableOffset;
  let newTail = tail;
  const cut = findStableCut(tokens, prev.stableCount + 1);
  // Declining an unverifiable advance costs one chunk of window growth and heals
  // on the next one; degrading would cost the rest of the stream.
  if (cut > prev.stableCount && advanceTiles(tokens, prev.stableCount, cut, tail, 0)) {
    const advance = sumRaw(tokens, prev.stableCount, cut);
    stableCount = cut;
    stableOffset = prev.stableOffset + advance;
    newTail = tail.slice(advance);
  }

  return {
    tokens,
    cache: {
      source,
      tail: newTail,
      tokens,
      stableCount,
      stableOffset,
      degraded: false,
      degradedReason: null,
    },
    charsLexed: tail.length,
    reusedTokens: prev.stableCount,
  };
}
