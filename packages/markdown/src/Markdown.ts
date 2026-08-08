import {
  BidiResolver,
  Entity,
  type DevtoolsDescriptor,
  IRenderer,
  OBJECT_REPLACEMENT,
  type StyledSpan,
  type TextStyle,
  SVGEntity,
  beginVectoUserTiming,
  endVectoUserTiming,
  VECTO_USER_TIMING,
} from '@vectojs/core';
import { marked, type Token, type Tokens, type TokensList } from 'marked';
import {
  createStreamController,
  type BoundStreamController,
  type IncompleteMarkdownMode,
  type StreamController,
  type StreamControllerOptions,
} from './StreamController';
import {
  ContainerBackground,
  HorizontalRule,
  MarkdownContainer,
  QuoteBorder,
} from './markdown-entities';
import { ABBR_EXTENSIONS, collectAbbreviations } from './markdown-abbr';
import { CodeBlock } from './markdown-code';
import { CONTAINER_EXTENSIONS, type ContainerToken } from './markdown-container';
import { EMOJI_EXTENSIONS } from './markdown-emoji';
import { FOOTNOTE_EXTENSIONS, type FootnoteDefToken, footnoteMarker } from './markdown-footnote';
import { INS_MARK_EXTENSIONS } from './markdown-ins-mark';
import { SUPERSCRIPT_EXTENSIONS } from './markdown-superscript';
import {
  containsInlineMath,
  exToPx,
  isMathJaxReady,
  MATH_LANGS,
  MathBlock,
  paintInlineMath,
  preloadMathJax,
  rendersAsMath,
  renderMathToSVGDataURI,
  subscribeInlineMathRaster,
  unsubscribeInlineMathRaster,
} from './markdown-math';
import {
  collectSpans,
  decodeEntities,
  findUnclosedInline,
  renderInlineToRichText,
  type UnclosedInline,
} from './markdown-inline';

// `MathBlock`, `preloadMathJax` and `isMathJaxReady` were exported from this
// module before the math cluster moved to `markdown-math.ts`. Re-exported so the
// public API and every deep import stay valid.
export { isMathJaxReady, MathBlock, preloadMathJax } from './markdown-math';

// `CodeBlock`, `codeAtlasStats` and `codeAtlas` were exported from this module
// before the code block moved to `markdown-code.ts`. Re-exported so the public
// API and every deep import — including `packages/core/e2e` — stay valid.
export { CodeBlock, codeAtlas, codeAtlasStats } from './markdown-code';
import {
  containsImage,
  ensureInlineImageRaster,
  expectedImageParagraphChildren,
  imagesOf,
  lastIndexOfImage,
  liftNestedImages,
  paragraphHasImage,
  stripImages,
  subscribeInlineImageRaster,
  unsubscribeInlineImageRaster,
} from './markdown-image';
import { type MarkdownThemePresetName, resolvePresetTheme } from './markdown-presets';
import { containerColor, headingSize, type MarkdownTheme } from './theme';

// `MarkdownTheme` was exported from this module before the theme tokens moved to
// `theme.ts`. Re-exported so the public API and every deep import stay valid.
export type { MarkdownTheme } from './theme';
export type { MarkdownThemePresetName } from './markdown-presets';
export { isPresetName, PRESET_THEMES, resolvePresetTheme } from './markdown-presets';

/**
 * Monotonic clock, falling back to `Date.now` where `performance` is absent.
 *
 * Used only for the streaming stats, so a coarse fallback is acceptable — but the
 * fallback matters: a worker round trip under 1ms would read as 0 and make the
 * total look like the worker cost nothing.
 */
const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

/**
 * Whether two abbreviation dictionaries hold the same term → definition pairs.
 *
 * Used by {@link Markdown.updateTokens} to decide whether a changed `*[TERM]:
 * …` set invalidates the raw-equal token prefix — see that call site's
 * comment. Size first as a cheap reject, then every entry, since a `Map`
 * has no structural equality of its own.
 */
function mapsEqual(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}

function lexMarkdown(text: string, userTiming: boolean): TokensList {
  if (!userTiming) return marked.lexer(text);
  const timing = beginVectoUserTiming(VECTO_USER_TIMING.markdown.parse);
  try {
    return marked.lexer(text);
  } finally {
    if (timing) endVectoUserTiming(timing);
  }
}

marked.use({
  // `FOOTNOTE_EXTENSIONS`, `SUPERSCRIPT_EXTENSIONS`, `INS_MARK_EXTENSIONS`,
  // `EMOJI_EXTENSIONS`, `CONTAINER_EXTENSIONS`, and `ABBR_EXTENSIONS` are
  // shared with `MarkdownWorker.ts` rather than spelled out twice: the two
  // registration sites must agree exactly, or the worker returns tokens this
  // renderer has no arm for.
  extensions: [
    ...FOOTNOTE_EXTENSIONS,
    ...SUPERSCRIPT_EXTENSIONS,
    ...INS_MARK_EXTENSIONS,
    ...EMOJI_EXTENSIONS,
    ...CONTAINER_EXTENSIONS,
    ...ABBR_EXTENSIONS,
    {
      name: 'blockMath',
      level: 'block',
      start(src) {
        return src.match(/^ {0,3}\$\$/m)?.index;
      },
      tokenizer(src) {
        // Display math: `$$...$$`, opening at the start of a line (up to three
        // spaces of indent, as CommonMark allows for other block starts). The
        // content may span lines; the first closing `$$` ends it.
        //
        // This must exist as a *block* rule. The inline `inlineMath` rule below
        // deliberately refuses `$$` to protect currency ("$5 to $10"), so with
        // no block rule marked's text tokenizer consumes the leading `$`, the
        // inline rule then matches the inner `$...$` pair, and the outer two
        // dollars are painted as literal text on either side of the formula.
        const match = /^ {0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/.exec(src);
        if (match) {
          return {
            type: 'blockMath',
            raw: match[0],
            text: match[1].trim(),
          };
        }
        return undefined;
      },
      renderer(token) {
        return token.raw;
      },
    },
    {
      name: 'inlineMath',
      level: 'inline',
      start(src) {
        return src.match(/(?<![\\$])\$(?![$\s])/)?.index;
      },
      tokenizer(src) {
        // Guard against currency: "$5 to $10" must NOT become one math span.
        // Require, à la pandoc: the opening `$` is not `$$` and is immediately
        // followed by a non-space, non-digit; the content has no literal `$`
        // (only escaped `\$`) and no newline; the closing `$` is preceded by a
        // non-space and not followed by a digit. So "$x+1$" is math, but "$5",
        // "$5 to $10", "$$", and "cost $9 each" are not.
        const match = /^\$(?![$\s\d])((?:\\\$|[^$\n])*?)(?<!\s)\$(?!\d)/.exec(src);
        if (match) {
          return {
            type: 'inlineMath',
            raw: match[0],
            text: match[1].trim(),
          };
        }
        return undefined;
      },
      renderer(token) {
        return token.raw;
      },
    },
  ],
});

import { type ButtonOptions, RichText, Stack, Table, Text, Image, UIComponent } from '@vectojs/ui';
import {
  BlockAffordanceButton,
  defaultSaveFile,
  defaultWriteClipboard,
  extensionForLanguage,
  mimeForLanguage,
  BlockWithAffordances,
  tableContentOf,
  tableToCsv,
  tableToMarkdown,
} from './blockAffordances';
import { parseFrontMatterFields, scanFrontMatter } from './frontMatter';

// @ts-ignore
import { WORKER_SOURCE_STRING } from './MarkdownWorkerSource';

// ── Worker Setup ─────────────────────────────────────────────────────────────

let markdownWorker: Worker | null = null;
let workerIdCounter = 0;
// Distinguishes Markdown instances in the worker's prior-raws cache (one worker
// is shared by every instance on the page).
let workerInstanceCounter = 0;
// `cb` receives (matchLen, tail): the caller's own tokens[0..matchLen) are
// still valid (unchanged raw source) and only `tail` is new — see the
// matching comment in MarkdownWorker.ts for why the worker sends a diff
// instead of the full re-lexed tree on every call.
// `cb`'s third argument says the result came from the main-thread fallback lexer
// rather than the worker, which matters because the worker's copy of the source
// is then behind and the next request must not send a delta against it.
// `onNeedResync` is invoked instead of `cb` when the worker reports that what it
// holds for this instance (prior token raws, or the document source itself) is
// missing or stale; the requester re-dispatches once with both attached.
/**
 * What the worker's lex actually cost, as opposed to how much of the token array
 * survived the diff. Absent on the main-thread fallback path, which does its own
 * lexing and is timed by the caller.
 */
interface LexCost {
  /** Wall-clock ms inside `marked.lexer()`. */
  lexerMs: number;
  /** Characters handed to the lexer — the WHOLE accumulated source, every time. */
  sourceCharsLexed: number;
}

const workerCallbacks = new Map<
  number,
  {
    cb: (matchLen: number, tail: TokensList, local?: boolean, lex?: LexCost) => void;
    onNeedResync?: () => void;
    /**
     * This request produced no update at all and never will — the worker failed
     * AND the main-thread fallback lexer threw too. The requester's in-flight
     * bookkeeping has to be cleared by something, or a `close()` awaiting
     * settlement would wait on a reply that can no longer come.
     */
    onDropped?: () => void;
    text: string;
    userTiming: boolean;
  }
>();

/**
 * The worker failed for this request (lexer threw, or the worker itself
 * died). Dropping the callback would lose that update for good — for the
 * final chunk of a stream that means content that never renders. Parse on
 * the main thread instead; it is the exact code path the no-Worker
 * environments already use. No prefix to trust here (this is a fresh local
 * parse, not a diff against the caller's own snapshot), so treat the whole
 * result as new — the caller's own `updateTokens` still reconciles it
 * correctly, just without the transfer-size saving for this one call.
 */
function runSyncFallback(entry: {
  cb: (matchLen: number, tail: TokensList, local?: boolean, lex?: LexCost) => void;
  onDropped?: () => void;
  text: string;
  userTiming: boolean;
}): void {
  try {
    // `local: true` — the worker did not produce this, so it never saw this
    // source and the requester must resync before it can send a delta again.
    entry.cb(0, lexMarkdown(entry.text, entry.userTiming), true);
  } catch (err) {
    console.warn('Markdown sync fallback parse failed', err);
    // Both paths are gone, so no update will ever land for this request. Tell the
    // requester, or its in-flight flag stays set forever and anything awaiting
    // settlement (a `close()`) never resolves.
    entry.onDropped?.();
  }
}

if (typeof Worker !== 'undefined') {
  try {
    const blob = new Blob([WORKER_SOURCE_STRING], {
      type: 'application/javascript',
    });
    markdownWorker = new Worker(URL.createObjectURL(blob));
    markdownWorker.onmessage = (e) => {
      const { id, matchLen, tail, error, needResync, lexerMs, sourceCharsLexed } = e.data;
      const entry = workerCallbacks.get(id);
      if (entry) {
        workerCallbacks.delete(id);
        if (needResync && entry.onNeedResync) {
          // The worker can't trust what it holds — retry with the full text and
          // the prior raws attached.
          entry.onNeedResync();
        } else if (needResync) {
          // No retry path (shouldn't happen); parse locally rather than drop it.
          runSyncFallback(entry);
        } else if (!error) {
          entry.cb(matchLen as number, tail as TokensList, false, {
            lexerMs: typeof lexerMs === 'number' ? lexerMs : 0,
            sourceCharsLexed: typeof sourceCharsLexed === 'number' ? sourceCharsLexed : 0,
          });
        } else {
          runSyncFallback(entry);
        }
      }
    };
    markdownWorker.onerror = () => {
      // The worker itself crashed: flush every pending request synchronously
      // and stop routing to it.
      const pending = [...workerCallbacks.values()];
      workerCallbacks.clear();
      markdownWorker = null;
      for (const entry of pending) runSyncFallback(entry);
    };
  } catch (err) {
    console.warn('Failed to initialize MarkdownWorker', err);
  }
}

// ── Main Markdown component ─────────────────────────────────────────────────

export interface MarkdownOptions {
  maxWidth?: number;
  /**
   * A full/partial {@link MarkdownTheme}, or the name of a built-in preset
   * (`'githubDark'` | `'githubLight'` | `'dracula'` | `'solarizedDark'` |
   * `'solarizedLight'`). Resolved through {@link resolvePresetTheme}, which
   * still applies {@link resolveTheme}'s derivations (`tableFontSize`,
   * `quoteTextColor`, `footnoteColor`) on top of a preset.
   */
  theme?: MarkdownThemePresetName | MarkdownTheme;
  onLinkClick?: (url: string) => void;
  /** Allow browser-native drag selection and copy for rendered text. Default `true`. */
  selectable?: boolean;
  /** Emit a `vecto:markdown:parse` User Timing measure. Default `false`. */
  userTiming?: boolean;
  /**
   * Draw copy / download controls in the top-right corner of code blocks and
   * tables. Default `false`.
   *
   * Opt-in rather than on by default because it adds two focusable stops per such
   * block to the tab order, which a document with many code fences would make
   * tedious to navigate past, and because a reader who cannot act on a control
   * (no clipboard permission, no filesystem) is better served by not being
   * offered one.
   */
  blockAffordances?: boolean;
  /**
   * Writes text to the clipboard for the copy controls.
   *
   * Injectable because the real path (`navigator.clipboard.writeText`) is absent
   * in jsdom and, in a browser, rejects a write that did not originate in a user
   * gesture — so a test can only assert the payload, never the platform call.
   * Defaults to `navigator.clipboard.writeText` when available.
   */
  writeClipboard?: (text: string) => void;
  /**
   * Saves a generated file for the download controls.
   *
   * Defaults to an anchor-click download that revokes its object URL. Injectable
   * for the same reason as {@link MarkdownOptions.writeClipboard}: jsdom has no
   * download behaviour to observe.
   */
  saveFile?: (filename: string, content: string, mimeType: string) => void;
}

interface BlockMetrics {
  marginBefore: number;
  marginAfter: number;
  indentStart: number;
  availableWidth: number;
}

/**
 * Renders Markdown content into a VectoJS entity tree using {@link marked}.
 *
 * Supported token types:
 * - **Headings** (h1–h6) with scaled font sizes
 * - **Paragraphs** with word-wrapping
 * - **Code blocks** with syntax-keyword highlighting and a rounded background
 * - **Blockquotes** with a left accent bar
 * - **Unordered / ordered lists** with bullets / numbers
 * - **Horizontal rules**
 * - **Inline code** (via backticks)
 * - **Footnotes** — `[^1]` renders as a small tinted `[1]` marker, and
 *   `[^1]: note` as its own block. Single-line definitions only; see
 *   `markdown-footnote.ts`.
 *
 * @example
 * const md = new Markdown('# Hello\\nSome *text*', { maxWidth: 600 });
 * scene.add(md.setPosition(40, 40));
 */
export class Markdown extends UIComponent {
  public content: Stack;
  public maxWidth: number;
  public theme: Required<MarkdownTheme>;
  public onLinkClick?: (url: string) => void;
  public selectable: boolean;
  /**
   * Whether code blocks and tables carry copy / download controls.
   *
   * Read when a block entity is built, so it affects blocks rendered from here on
   * rather than retroactively; a document does not rebuild to gain or lose an
   * affordance.
   */
  public blockAffordances: boolean;
  /** Clipboard writer used by the copy controls. */
  public writeClipboard: (text: string) => void;
  /** File saver used by the download controls. */
  public saveFile: (filename: string, content: string, mimeType: string) => void;
  private activeBlockMetrics: BlockMetrics | null = null;
  /**
   * Called after a streamed append has re-laid-out the document.
   *
   * Not required for a `VirtualList` to track a streaming row's height: the list
   * re-reads `height` on every mounted row each frame, so it sees this entity grow
   * without being told. Prefer that over wiring this up — it fires from the append
   * path only, **not** from `setContent()`, so it is not a complete size signal.
   */
  public onLayoutUpdated?: () => void;
  /**
   * The document's BODY text — everything after any front matter block.
   *
   * Front matter is stripped before it reaches here, so this is the exact string
   * the lexer sees. That matters for more than tidiness: `workerSourceLen` and
   * `expectedLength` are offsets into this string, and the worker reassembles the
   * source it lexes as `cached.source + append`, so a front matter block left in
   * would have to be accounted for identically on both sides of `postMessage`.
   * Stripping ahead of the offset arithmetic means the worker needs no notion of
   * front matter at all.
   */
  private rawMarkdown: string;
  /** Raw contents of the front matter block, or `''` when the document has none. */
  private _frontMatter = '';
  /** Memoized {@link parseFrontMatterFields} over {@link _frontMatter}. */
  private frontMatterFieldsCache: Readonly<Record<string, string>> | null = null;
  /**
   * Whether the front matter question has been settled for this document.
   *
   * While `false`, appended text is held in {@link frontMatterHold} rather than
   * lexed: a document that opens `---\ntitle: A` may still turn out to carry
   * metadata, and lexing that prefix would paint a thematic break and a setext
   * heading that a later chunk then has to tear down. Resolved either by the scan
   * reaching a verdict or by {@link finalizeFrontMatter} at end of stream.
   */
  private frontMatterResolved = false;
  /** Text withheld from the lexer while {@link frontMatterResolved} is `false`. */
  private frontMatterHold = '';
  private streamController: BoundStreamController | null = null;
  /**
   * Trailing-unclosed-syntax policy of the active stream, or `'literal'` when no
   * stream is open.
   *
   * Held here rather than read back off the controller because it is a rendering
   * concern: `StreamController` owns buffering and pacing and has no view of the
   * entity tree, while the guess is a transform applied where spans are built.
   */
  private streamIncompleteMode: IncompleteMarkdownMode = 'literal';
  /** End-of-stream callback of the active stream, if it supplied one. */
  private streamOnStable: ((blocks: readonly Entity[]) => void) | null = null;
  /**
   * The trailing paragraph entity currently showing an optimistic guess, plus the
   * token it was rendered from.
   *
   * Both halves are needed. The entity is what must be re-rendered to drop the
   * guess; the token is what it must be re-rendered FROM, and it is the only
   * copy — `this.tokens` has already moved on by the time an unwind is decided.
   * `null` means no guess is live, which is the state every `'literal'` stream
   * and every closed stream stays in.
   */
  private optimisticTail: { entity: Entity; token: Tokens.Paragraph } | null = null;
  /** Resolvers waiting for every in-flight worker append to have been applied. */
  private appendSettledWaiters: Array<() => void> = [];
  /** True only inside an `onStable` callback, to reject reentrant mutation. */
  private inStableCallback = false;
  /** Set by {@link destroy} so late settlement work skips a torn-down tree. */
  private isDestroyed = false;
  /**
   * This instance's entry in {@link inlineMathRasterWaiters}, or `undefined` if it
   * has never rendered inline math.
   *
   * Subscribed lazily so a document without formulas costs nothing, and held as a
   * field only so {@link destroy} can remove the exact closure it added.
   */
  private inlineMathRepaint?: () => void;
  /**
   * This instance's entry in the inline-image decode waiters, or `undefined` if it
   * has never rendered an image. Held as a field only so {@link destroy} can remove
   * the exact closure it added.
   */
  private inlineImageRemeasure?: () => void;
  /**
   * URLs whose decoded aspect ratio this document has already reserved a box for.
   *
   * The guard that makes the re-measure fire once per image rather than once per
   * decode-notification-per-image: the waiter set is module-level, so a page of
   * many documents tells all of them about all decodes.
   */
  private readonly inlineImagesMeasured = new Set<string>();
  /**
   * True while this document is waiting on the lazy MathJax load.
   *
   * Tracked per instance rather than read off the module state because it also
   * gates settlement: `await close()` and `onStable` must not resolve while a
   * formula is still showing TeX source, or a caller doing expensive one-time
   * work on a "final" document would measure and export placeholder boxes.
   */
  private mathLoadPending = false;
  private _userTiming: boolean;
  private tokens: Token[] = [];
  /**
   * The document's `*[TERM]: definition` dictionary, collected from
   * {@link tokens}'s top-level `abbrDef` entries.
   *
   * Recomputed whenever {@link setTokens} runs. Its own identity — not its
   * CONTENTS — is what {@link updateTokens} compares against the previous
   * render to decide whether prose rendered before this definition existed
   * needs a full rebuild rather than the usual prefix-reuse: see
   * `markdown-abbr.ts`'s module doc for why a late-arriving definition can
   * retroactively change already-rendered inline tokens, the same hazard
   * `hasLinkDefinitions` names for reference definitions.
   */
  private abbreviations: ReadonlyMap<string, string> = new Map();
  // At most one worker lex request in flight at a time. Required for the
  // delta-transfer protocol below to be safe: the request captures a
  // snapshot of `this.tokens` to reconstruct the full array from the
  // worker's (matchLen, tail) response, and that snapshot would go stale if
  // another request's callback could run — and mutate `this.tokens` — while
  // this one is still pending. `appendPending` means "more text arrived
  // while a request was in flight"; the in-flight callback re-dispatches
  // with the latest accumulated text once it resolves.
  private appendInFlight = false;
  private appendPending = false;
  /**
   * Streaming counters for the DevTools inspector.
   *
   * Cheap enough to keep always-on (a handful of integer increments per append).
   *
   * The token counters describe the **token diff and the transfer**, which is a
   * different thing from the parser's cost — `lexerMs` and `sourceCharsLexed` are
   * what report that. An earlier version of these counters was named as though a
   * high prefix match meant less lexing, which sent readers to optimise the
   * already-solved transfer path.
   *
   * `marked` still has no incremental lexing API, but the worker no longer lexes
   * the whole accumulated source per chunk: `incrementalLex` tracks the last
   * stable block boundary and lexes only the text after it, so `sourceCharsLexed`
   * now reports the unstable tail. Two document shapes are excluded and do still
   * pay O(document) per append — see `DegradeReason` — so a `sourceCharsLexed`
   * that tracks the document length is the signal that this instance degraded.
   */
  private streamStats = {
    appends: 0,
    workerResponses: 0,
    /**
     * Sum of `matchLen`: leading tokens whose `raw` was unchanged, so the main
     * thread kept its existing token objects and child entities. Still a prefix
     * match rather than a lexer saving — the two now usually coincide, since the
     * stable boundary skips lexing most of what this counter covers, but they are
     * measured independently and a degraded instance has a high match and no
     * lexing saving at all.
     */
    tokensPrefixMatched: 0,
    /**
     * Sum of returned tail lengths: tokens the worker sent back because their
     * `raw` differed. This is the structured-clone payload size in tokens, which
     * is what the delta protocol exists to keep small.
     */
    tokensReturned: 0,
    /** Total ms spent inside `marked.lexer()` across worker responses. */
    lexerMs: 0,
    /**
     * Characters handed to the lexer, summed across responses. With a stable
     * boundary this is O(n·window) over a stream of n chunks; it returns to the
     * old ~O(n²) only for a degraded instance, which is what makes an unexpectedly
     * large value here worth investigating rather than ignoring.
     */
    sourceCharsLexed: 0,
    /** Total round-trip ms across worker lex requests, dispatch to callback. */
    workerMs: 0,
    /** Longest single worker round trip, which is what a dropped frame feels. */
    workerMsMax: 0,
    /**
     * Source length of the stable prefix on the most recent append: the text the
     * worker matched and did not re-read.
     */
    stablePrefixChars: 0,
    /** Source length of the tail whose tokens changed on the most recent append. */
    changedTailChars: 0,
    /** Child entities kept across reconciles, either untouched or updated in place. */
    entitiesReused: 0,
    /** Child entities destroyed and rebuilt across reconciles. */
    entitiesRebuilt: 0,
    /** In-place updates via setCode/setSpans, the streaming fast path. */
    inPlaceUpdates: 0,
  };
  // Worker request ids dispatched by *this* instance that haven't resolved yet.
  // The module-level `workerCallbacks` map holds a closure capturing `this`, so
  // destroying a Markdown mid-stream would pin the whole entity (and its subtree)
  // until the worker replied. `destroy()` drops these so the instance is GC-able.
  private pendingWorkerIds = new Set<number>();
  // Identity + token-list version for the worker's prior-raws cache. The worker
  // keeps this instance's last raw list so a streaming append sends only the new
  // text; `tokenVersion` is bumped on EVERY `this.tokens` mutation so any change
  // the worker didn't produce (setContent, a sync-fallback parse) invalidates
  // that cache instead of silently diffing against stale raws.
  private readonly workerInstanceId = `md-${workerInstanceCounter++}`;
  private tokenVersion = 0;
  /**
   * How many characters of {@link rawMarkdown} the worker is known to hold.
   *
   * The worker keeps the document source too, not just the prior token raws, so a
   * steady-state append posts only the new chunk instead of the whole document —
   * that term was O(document) per chunk, i.e. O(N²) over a stream, and unlike the
   * re-lex it accompanies it is paid on the MAIN thread (structured-cloning the
   * string happens in `postMessage`, not in the worker). Measured on a 240Hz
   * panel: 4µs per append at 8KB rising to 220µs at 512KB on Chrome, against a
   * flat ~2µs for a chunk-sized post.
   *
   * 0 means the worker holds nothing for this instance, so the next request must
   * carry the full text. It is only advanced when a response proves the worker
   * accepted that source, and reset to 0 by anything the worker did not produce
   * ({@link setContent}, a sync-fallback parse, a worker error or crash).
   */
  private workerSourceLen = 0;
  // `tokenChildPrefix[i]` = how many of `tokens[0..i)` render a child entity, so
  // `updateTokens` can map a token index to its child slot in O(1). Maintained
  // incrementally by setTokens() (only the changed suffix is recomputed).
  private readonly tokenChildPrefix: number[] = [];

  /**
   * Replace the token list, invalidate the worker's cached raws for it, and
   * refresh {@link tokenChildPrefix} — the token-index → child-entity-index
   * prefix sum `updateTokens` needs.
   *
   * `validFrom` is the number of leading tokens whose prefix entries are still
   * correct (the raw-equal prefix), so only the changed suffix is recomputed
   * instead of rebuilding over every token on every streamed chunk.
   */
  private setTokens(tokens: Token[], validFrom = 0): void {
    this.tokens = tokens;
    this.tokenVersion++;

    const prefix = this.tokenChildPrefix;
    const keep = Math.min(validFrom, prefix.length, tokens.length);
    prefix.length = keep;
    // Resume the running child count from the kept prefix's last entry.
    let childIdx = 0;
    if (keep > 0) {
      childIdx = prefix[keep - 1];
      if (this.producesEntity(tokens[keep - 1])) childIdx++;
    }
    for (let i = keep; i < tokens.length; i++) {
      prefix.push(childIdx);
      if (this.producesEntity(tokens[i])) childIdx++;
    }
  }

  constructor(markdownText: string, opts: MarkdownOptions = {}) {
    super();
    this.maxWidth = opts.maxWidth ?? 800;
    this.theme = resolvePresetTheme(opts.theme);
    this.onLinkClick = opts.onLinkClick;
    this.selectable = opts.selectable ?? true;
    this._userTiming = opts.userTiming ?? false;
    this.blockAffordances = opts.blockAffordances ?? false;
    this.writeClipboard = opts.writeClipboard ?? defaultWriteClipboard;
    this.saveFile = opts.saveFile ?? defaultSaveFile;

    this.content = new Stack({
      direction: 'vertical',
      gap: this.theme.blockGap,
    });
    this.add(this.content);

    this.rawMarkdown = '';
    this.setTokens([]);
    this.renderMarkdown(this.initSource(markdownText));
  }

  /**
   * Seed {@link rawMarkdown} from a whole document, stripping front matter.
   *
   * Shared by the constructor and {@link setContent} so both resolve front matter
   * identically. Returns the body text to lex.
   *
   * The text is treated as a stream prefix (`complete: false`) rather than a whole
   * document, even though the caller handed over everything it has. The reason is
   * that a `Markdown` built from one string can still be appended to — the
   * streaming API is `new Markdown('')` plus `appendMarkdown` — so declaring the
   * document complete here would settle the front matter question against a
   * prefix. What makes that safe for a genuine one-shot document is that the only
   * text a scan can hold is an opener followed by keys and no closer, and that
   * document renders nothing until either the closer arrives or the stream ends,
   * which is precisely what {@link finalizeFrontMatter} is for.
   */
  private initSource(markdown: string): string {
    this._frontMatter = '';
    this.frontMatterFieldsCache = null;
    this.frontMatterResolved = false;
    this.frontMatterHold = '';
    this.rawMarkdown = '';
    // A whole string was handed over, so the front matter question is decidable
    // now: nothing is held, and no document renders blank waiting for a chunk
    // that is not coming. Both halves of that matter — `new Markdown('---')` is a
    // thematic break and must paint a rule, while a document that is entirely
    // front matter must render empty with its metadata readable.
    //
    // The streaming entry point is not sacrificed to this: `scanFrontMatter`
    // returns `pending` for the empty string even when told the text is complete,
    // precisely so `new Markdown('')` plus `appendMarkdown` still recognises front
    // matter arriving in a later chunk.
    //
    // What this does give up is a constructor seeded with a PARTIAL block that
    // later appends complete — `new Markdown('---')` then appending
    // `'\ntitle: A\n---'`. That reverts to marked's own output (a rule plus a
    // setext heading), because the rule was already painted and the body string
    // the worker holds an offset into can only grow.
    const scan = scanFrontMatter(markdown, true);
    if (scan.kind === 'pending') return this.consumeFrontMatter(markdown);
    this.frontMatterResolved = true;
    if (scan.kind === 'found') {
      this._frontMatter = scan.raw;
      this.rawMarkdown = markdown.slice(scan.bodyStart);
    } else {
      this.rawMarkdown = markdown;
    }
    return this.rawMarkdown;
  }

  /**
   * Fold `chunk` into {@link rawMarkdown}, diverting any leading front matter.
   *
   * Returns the body text accumulated so far, which is `rawMarkdown` — returned
   * rather than read back by the caller so the two paths that lex cannot
   * accidentally lex a stale copy.
   */
  private consumeFrontMatter(chunk: string): string {
    if (this.frontMatterResolved) {
      this.rawMarkdown += chunk;
      return this.rawMarkdown;
    }
    this.frontMatterHold += chunk;
    const scan = scanFrontMatter(this.frontMatterHold, false);
    if (scan.kind === 'pending') return this.rawMarkdown;
    this.frontMatterResolved = true;
    if (scan.kind === 'found') {
      this._frontMatter = scan.raw;
      this.rawMarkdown = this.frontMatterHold.slice(scan.bodyStart);
    } else {
      this.rawMarkdown = this.frontMatterHold;
    }
    this.frontMatterHold = '';
    return this.rawMarkdown;
  }

  /**
   * Settle an unresolved front matter question because no more text is coming.
   *
   * An opener whose closing delimiter never arrives is not front matter — it is a
   * thematic break followed by content, which is what marked produced before this
   * stripping existed. Releasing the held text here is what keeps that document
   * rendering rather than staying blank.
   *
   * Returns `true` when text was released, so the caller knows a re-lex is due.
   */
  private finalizeFrontMatter(): boolean {
    if (this.frontMatterResolved) return false;
    this.frontMatterResolved = true;
    if (this.frontMatterHold.length === 0) return false;
    this.rawMarkdown += this.frontMatterHold;
    this.frontMatterHold = '';
    return true;
  }

  /**
   * Raw contents of the document's YAML front matter block, or `''` when it has
   * none.
   *
   * Verbatim text between the delimiters, unparsed — this package does not depend
   * on a YAML parser. Use {@link frontMatterFields} for the common `key: value`
   * case, or hand this to a real parser for anything richer.
   *
   * Empty while a stream is still inside an unclosed block.
   */
  public get frontMatter(): string {
    return this._frontMatter;
  }

  /**
   * Top-level scalar `key: value` pairs of {@link frontMatter}.
   *
   * A narrow convenience, not YAML: nested mappings, sequences and block scalars
   * are skipped rather than guessed at. See `parseFrontMatterFields`.
   */
  public get frontMatterFields(): Readonly<Record<string, string>> {
    this.frontMatterFieldsCache ??= Object.freeze(parseFrontMatterFields(this._frontMatter));
    return this.frontMatterFieldsCache;
  }

  private renderMarkdown(text: string): void {
    const tokens = lexMarkdown(text, this._userTiming);
    this.setTokens(tokens);
    // Collected over the WHOLE token list before any block renders, not
    // per-token as the loop below reaches each one: a definition can appear
    // anywhere in the document, including after its first use (the same
    // shape footnotes allow), so a term used in an early paragraph must still
    // resolve against a definition written later in the same document.
    this.abbreviations = collectAbbreviations(tokens);
    for (const token of tokens) {
      const el = this.renderToken(token);
      if (el) {
        this.content.add(el);
      }
    }

    this.width = this.content.width;
    this.height = this.content.height;
  }

  /** Create a frame-coalesced stream bound to this Markdown instance. */
  public createStream(options: StreamControllerOptions = {}): StreamController {
    if (this.streamController) {
      throw new Error('Markdown already has an active StreamController');
    }
    const controller = createStreamController(
      {
        append: (chunk) => this.appendMarkdownCore(chunk),
        release: (released) => {
          if (this.streamController !== released) return;
          this.streamController = null;
          this.streamIncompleteMode = 'literal';
          this.streamOnStable = null;
          // Covers abort()/destroy(), which release without ever running onClose:
          // a guess must not outlive the stream that justified it. After a normal
          // close() this is already a no-op — onClose unwound it.
          this.unwindOptimisticTail();
        },
        onClose: async () => {
          // A front matter block whose closing delimiter never arrived is not
          // metadata — the stream ended, so it is content. Release it BEFORE
          // settling: it produces body text with no chunk behind it, and
          // `onStable` is handed the finished document, which must include it.
          if (this.finalizeFrontMatter()) this.relexBody();
          // The last committed chunk may still be in the worker. Waiting here is
          // what makes `await close()` mean "the document reflects everything
          // written", which onStable's contract depends on.
          await this.waitForAppendSettled();
          if (this.isDestroyed) return;
          // Converge on marked's own output: a guess is never part of the final
          // document, so a literal and an optimistic stream of the same source
          // end identically.
          this.unwindOptimisticTail();
          const onStable = this.streamOnStable;
          if (!onStable) return;
          this.inStableCallback = true;
          try {
            onStable(Array.from(this.content.children));
          } finally {
            this.inStableCallback = false;
          }
        },
      },
      options,
    );
    if (controller.state === 'open') {
      this.streamController = controller;
      this.streamIncompleteMode = options.incompleteMode ?? 'literal';
      this.streamOnStable = options.onStable ?? null;
    }
    return controller;
  }

  /**
   * Change the wrap width and reflow the existing blocks in place.
   *
   * `Text` and `RichText` both have this; `Markdown`, which composes them, did
   * not — and assigning `maxWidth` alone does nothing visible, because the width
   * is read when each block is *built*. A document whose field was reassigned
   * therefore kept every block wrapped at the previous width.
   *
   * The only correct workaround was a full rebuild, and a real consumer had
   * written one: `vectojs-gallery`'s chat Creation released its stream, replayed
   * every revealed character through {@link setContent}, constructed a **new**
   * stream writer because the old one was bound to blocks `setContent` had
   * discarded, and carried its scroll offset across by hand — on every resize
   * frame that changed the width. This method exists so that is unnecessary.
   *
   * What it does instead: walk the retained token list beside the existing child
   * entities and hand each block its new width, recursing into blockquotes and
   * list/image stacks. Nothing is re-lexed, no entity is destroyed or created, and
   * an open {@link createStream} writer stays valid because the block structure it
   * is bound to is untouched. `RichText`'s paragraph memo is keyed on content
   * rather than width, so a re-wrap reuses the shaping and pays only for line
   * breaking.
   *
   * Safe to call with an unchanged width (returns immediately) and safe to call
   * mid-stream. It is *not* callable from an `onStable` callback, for the same
   * reason {@link setContent} is not: that callback is handed the finished block
   * list and mutating geometry underneath it is a reentrancy hazard.
   *
   * @returns `this` for chaining.
   */
  public setMaxWidth(maxWidth: number): this {
    this.assertNotInStableCallback('setMaxWidth');
    const next = Math.max(0, maxWidth);
    if (next === this.maxWidth) return this;
    this.maxWidth = next;

    // Same pairing `updateTokens` relies on: `producesEntity` decides which tokens
    // own a child, in order. Walking both together is what lets a reflow know a
    // `MarkdownContainer` is a blockquote rather than a display-math wrapper —
    // they are the same class, so the entity tree alone cannot say.
    let childIndex = 0;
    const children = this.content.children;
    for (const token of this.tokens) {
      if (!this.producesEntity(token)) continue;
      const child = children[childIndex++];
      if (!child) break;
      this.reflowToken(token, child, next);
    }

    this.content.layout();
    this.width = this.content.width;
    this.height = this.content.height;
    this.onLayoutUpdated?.();
    this.scene?.markDirty();
    return this;
  }

  /**
   * Re-apply `availableWidth` to one already-built block.
   *
   * Deliberately mirrors {@link renderToken}'s `switch` arm for arm: the two must
   * agree on what a token's entity looks like, and keeping the shapes adjacent is
   * what makes a divergence visible. A token type missing here keeps its old width
   * rather than being rebuilt — wrong on screen, but never a crash or a lost
   * entity, which is the right failure mode for a layout pass.
   */
  private reflowToken(token: Token, entity: Entity, availableWidth: number): void {
    switch (token.type) {
      case 'heading':
      case 'paragraph': {
        // An ordinary paragraph or heading is one `RichText`. An image-bearing
        // paragraph is a `Stack` of alternating runs and images, which is why this
        // dispatches on the entity rather than on `paragraphHasImage`: a streamed
        // paragraph can have gained its first image since it was built.
        if (entity instanceof RichText) {
          entity.setMaxWidth(availableWidth);
          return;
        }
        if (entity instanceof Stack) {
          entity.maxWidth = availableWidth;
          for (const run of entity.children) {
            if (run instanceof RichText) run.setMaxWidth(availableWidth);
            else if (run instanceof Image) this.refitParagraphImage(run, availableWidth);
          }
          entity.layout();
        }
        return;
      }

      case 'blockMath':
      case 'code': {
        // A math block that typeset is a `MarkdownContainer` wrapping an `Image`
        // whose box came from MathJax's own `ex`-relative metrics, not from the
        // available width — so it is already correct at any width and must not be
        // stretched. One that has not typeset yet is a `CodeBlock` showing the TeX
        // source, and reflows as code does.
        if (entity instanceof CodeBlock) entity.setWidth(availableWidth);
        return;
      }

      case 'blockquote': {
        const bqToken = token as Tokens.Blockquote;
        // Shape built by the `blockquote` arm: MarkdownContainer[QuoteBorder,
        // Stack[MarkdownContainer[block], …]].
        const innerStack = entity.children.find((c) => c instanceof Stack);
        const border = entity.children.find((c) => c instanceof QuoteBorder);
        const indentStart = Math.min(this.theme.quoteIndent, availableWidth);
        const childWidth = Math.max(0, availableWidth - indentStart);
        if (innerStack instanceof Stack && bqToken.tokens) {
          let index = 0;
          for (const inner of bqToken.tokens) {
            if (!this.producesEntity(inner)) continue;
            const wrapper = innerStack.children[index++];
            if (!wrapper) break;
            const block = wrapper.children[0];
            if (!block) continue;
            this.reflowToken(inner, block, childWidth);
            // The wrapper's geometry is derived, exactly as the render arm derives
            // it — re-deriving here is what keeps a nested quote's indent from
            // accumulating or collapsing across successive resizes.
            block.x = indentStart;
            wrapper.width = block.width + indentStart;
            wrapper.height = block.height;
          }
          innerStack.layout();
        }
        // The bar spans the quote's final height, which the reflow above may have
        // changed.
        if (border instanceof QuoteBorder && innerStack) {
          border.height = innerStack.height || 20;
        }
        entity.width = availableWidth;
        entity.height = Math.max(border?.height ?? 0, innerStack?.height ?? 0);
        return;
      }

      case 'container': {
        const ctToken = token as ContainerToken;
        // Shape built by the `container` render arm: MarkdownContainer[
        // ContainerBackground, QuoteBorder, Stack[MarkdownContainer[block], …]].
        // One layer deeper than `blockquote`'s only for the extra background fill.
        const innerStack = entity.children.find((c) => c instanceof Stack);
        const border = entity.children.find((c) => c instanceof QuoteBorder);
        const background = entity.children.find((c) => c instanceof ContainerBackground);
        const indentStart = Math.min(this.theme.containerIndent, availableWidth);
        const childWidth = Math.max(0, availableWidth - indentStart);
        if (innerStack instanceof Stack) {
          let index = 0;
          for (const inner of ctToken.tokens) {
            if (!this.producesEntity(inner)) continue;
            const wrapper = innerStack.children[index++];
            if (!wrapper) break;
            const block = wrapper.children[0];
            if (!block) continue;
            this.reflowToken(inner, block, childWidth);
            block.x = indentStart;
            wrapper.width = block.width + indentStart;
            wrapper.height = block.height;
          }
          innerStack.layout();
        }
        const contentHeight = innerStack?.height || 20;
        if (border instanceof QuoteBorder) border.height = contentHeight;
        if (background instanceof ContainerBackground) {
          background.width = availableWidth;
          background.height = contentHeight;
        }
        entity.width = availableWidth;
        entity.height = Math.max(background?.height ?? 0, border?.height ?? 0, contentHeight);
        return;
      }

      case 'list': {
        if (!(entity instanceof Stack)) return;
        for (const item of entity.children) {
          if (item instanceof RichText) item.setMaxWidth(availableWidth);
        }
        entity.layout();
        return;
      }

      case 'table': {
        // `setWidth`, not `width =`: a Table's cell wrapping and alignment derive
        // from `colWidths`, which is resolved once at construction.
        if (entity instanceof Table) entity.setWidth(availableWidth);
        return;
      }

      case 'hr': {
        if (entity instanceof HorizontalRule) entity.width = availableWidth;
        return;
      }

      case 'footnoteDef': {
        // Its own arm rather than joining `heading`/`paragraph` above: those
        // dispatch on `RichText` vs `Stack` because an image can split them, which
        // a single-line definition never is. Reaching the `default:` arm instead
        // would be a silent no-op — that arm only handles `Text`, and this builds
        // a `RichText`, so a resized definition would keep its old width forever.
        if (entity instanceof RichText) {
          entity.setMaxWidth(availableWidth);
          return;
        }
        // A multi-paragraph definition (continuation lines present) renders as
        // Stack[headerRichText, MarkdownContainer[block], …] — the same shape
        // `listItemBlockStack` uses for a block-bearing list item, mirrored here
        // for the same reason: the header's own width and each continuation
        // child's indent must both be re-derived, not just the Stack's own box.
        if (entity instanceof Stack) {
          const fnToken = token as FootnoteDefToken;
          entity.maxWidth = availableWidth;
          const header = entity.children[0];
          if (header instanceof RichText) header.setMaxWidth(availableWidth);
          const indent = Math.round(this.theme.fontSize);
          const childWidth = Math.max(1, availableWidth - indent);
          let index = 1; // children[0] is the header, already handled above.
          for (const inner of fnToken.tokens) {
            if (!this.producesEntity(inner)) continue;
            const wrapper = entity.children[index++];
            if (!wrapper) break;
            const block = wrapper.children[0];
            if (!block) continue;
            this.reflowToken(inner, block, childWidth);
            block.x = indent;
            wrapper.width = block.width + indent;
            wrapper.height = block.height;
          }
          entity.layout();
        }
        return;
      }

      default: {
        // The fallback arm builds a `Text`. `html` builds an `SVGEntity`, whose
        // intrinsic size is the SVG's own and is left alone.
        if (entity instanceof Text) entity.setMaxWidth(availableWidth);
        return;
      }
    }
  }

  /**
   * Rescale one image inside a paragraph to a new available width.
   *
   * The render arm captures `availableWidth` in the `onLoad` closure, so a resize
   * that lands *after* the bitmap decoded has no path back into that arithmetic.
   * Reproducing it here keeps a loaded image and a still-loading one converging on
   * the same box, and preserves the "never upscale past natural width" rule that
   * closure applies.
   */
  private refitParagraphImage(image: Image, availableWidth: number): void {
    // `naturalWidth`/`naturalHeight`, not `width`/`height`: `bitmap` is an
    // `HTMLImageElement`, whose `width`/`height` are the *layout* attributes and
    // are 0 for an element never inserted into a document. Using them would make
    // every decoded image fall through to the placeholder guess below.
    const bitmap = (image as unknown as { bitmap?: HTMLImageElement | null }).bitmap;
    if (bitmap?.naturalWidth && bitmap.naturalHeight) {
      const aspect = bitmap.naturalHeight / bitmap.naturalWidth;
      image.width = Math.min(bitmap.naturalWidth, availableWidth);
      image.height = Math.round(image.width * aspect);
      return;
    }
    // Not decoded yet: mirror the placeholder the render arm guesses, so the
    // reserved box tracks the width until the real aspect ratio arrives.
    image.width = Math.min(800, availableWidth);
    image.height = Math.round(image.width * 0.6);
  }

  /** Replace all markdown content (full rebuild). */
  public setContent(markdown: string): this {
    this.assertNotInStableCallback('setContent');
    this.streamController?.abort(new Error('Markdown content was replaced'));
    // Drop any in-flight worker request. Its `matchLen` is relative to a token
    // snapshot captured from the document being replaced, and its closure still
    // holds that snapshot, so applying the reply would rebuild the tree from a
    // document that no longer exists — leaving `tokens` disagreeing with
    // `rawMarkdown`, which makes the NEXT append diff against tokens the source
    // never had. The reply is genuinely worthless rather than merely late: the
    // text it describes was just discarded by this call.
    //
    // Clearing `appendInFlight` is the other half. It gates every dispatch, so
    // leaving it set after dropping the callback would make the next append set
    // `appendPending` and wait forever for a reply that can no longer arrive.
    for (const id of this.pendingWorkerIds) workerCallbacks.delete(id);
    this.pendingWorkerIds.clear();
    this.appendInFlight = false;
    this.appendPending = false;
    // The replies those callbacks would have delivered are gone, so anything
    // awaiting settlement has to be released here or it waits forever.
    this.flushAppendSettledWaiters();
    const body = this.initSource(markdown);
    // The worker's copy of the source now describes a document that no longer
    // exists, so the next append must resend the text rather than a delta.
    //
    // Two other mechanisms would eventually catch a stale length — the
    // `workerSourceLen <= sentLength` guard in dispatchAppend rejects it when the
    // replacement is shorter, and the `tokenVersion` bump in setTokens() below
    // makes the worker ask for a resync either way — but neither is a substitute.
    // The guard misses a replacement that grows past the old length, and relying
    // on the version bump means paying a wasted round trip on a request built
    // from an offset into a document that no longer exists.
    this.workerSourceLen = 0;
    // Destroy (not just detach) all children so their subtrees' resources —
    // MSDF worker slots, GPU buffers, portal observers — are released instead
    // of stranded. destroy() detaches from `content` as it goes.
    while (this.content.children.length > 0) {
      this.content.children[this.content.children.length - 1].destroy();
    }
    this.setTokens([]);
    this.renderMarkdown(body);
    return this;
  }

  /**
   * Tear down this Markdown block: drop any in-flight worker callbacks (each
   * pins `this` via its closure, so a mid-stream destroy would otherwise keep
   * the whole subtree alive until the worker replied), then recurse into the
   * content subtree via `super.destroy()` so every block's resources are freed.
   */
  /**
   * Repaint this document when an inline formula's raster finishes decoding.
   *
   * Idempotent — called on every render of a math-bearing token, and the set holds
   * one closure per instance.
   */
  private subscribeInlineMathRepaint(): void {
    if (this.inlineMathRepaint || this.isDestroyed) return;
    const repaint = () => {
      if (this.isDestroyed) return;
      this.scene?.markDirty();
    };
    this.inlineMathRepaint = repaint;
    subscribeInlineMathRaster(repaint);
  }

  /**
   * Re-measure this document when an inline image's raster finishes decoding.
   *
   * Inline images differ from inline formulas in one way that matters: a formula's
   * box is known synchronously the moment it typesets, while an image's aspect
   * ratio arrives only with the decode. The span reserved a square until then, so a
   * decode that reports anything else has invalidated a WIDTH, and a repaint into
   * the old box would letterbox or stretch the picture.
   *
   * So this rebuilds through {@link retypesetFromTokens} — the same late-arrival
   * path MathJax uses — but only when a reserved width actually changed. Every live
   * document is notified for every decode, including images it does not contain, so
   * an unconditional rebuild here would be O(documents x images) full re-renders
   * for a page of many blocks.
   *
   * Subscribed lazily and held as a field for the same two reasons as its math
   * counterpart: a document with no images costs nothing, and `destroy` must remove
   * the exact closure it added.
   */
  private subscribeInlineImageRemeasure(): void {
    if (this.inlineImageRemeasure || this.isDestroyed) return;
    const remeasure = () => {
      if (this.isDestroyed) return;
      // Cheap rejection first: only rebuild when one of THIS document's inline
      // image spans would now reserve a different box. `markDirty` alone is enough
      // for a decode that merely filled a box whose size was already correct.
      if (this.inlineImageBoxesStale()) this.retypesetFromTokens();
      else this.scene?.markDirty();
    };
    this.inlineImageRemeasure = remeasure;
    subscribeInlineImageRaster(remeasure);
  }

  /**
   * Whether any inline image in this document has just learned it is not square.
   *
   * An inline image's span reserves a square box before its raster decodes, because
   * that is the only shape available without a natural size. The decode supplies the
   * real aspect ratio, so a non-square image needs one rebuild to reserve the right
   * width — and exactly one. Every live document is notified of every decode on the
   * page, including images it does not contain, so this has to answer "did MY
   * geometry just change" and not merely "did something decode".
   *
   * Walks the tokens rather than the entity tree: the reserved box is a function of
   * the raster's aspect ratio, which is available here, and a token walk cannot be
   * confused by an entity a previous rebuild already corrected.
   *
   * Only headings and table cells are inspected. Every other context splits an image
   * into its own block whose `Image` entity resizes itself in `onLoad`, so a rebuild
   * for one of those would be pure cost.
   */
  private inlineImageBoxesStale(): boolean {
    const stale = (tokens: Token[] | undefined): boolean => {
      let changed = false;
      for (const token of tokens ?? []) {
        if (token.type === 'image') {
          const href = (token as Tokens.Image).href;
          // Already accounted for: the spans hold this URL's real aspect ratio, so a
          // later notification must not rebuild for it again. Without this the
          // predicate stays true forever and every decode anywhere on the page costs
          // this document a full re-render.
          if (this.inlineImagesMeasured.has(href)) continue;
          const raster = ensureInlineImageRaster(href);
          // A failed decode has to rebuild too: the span arm replaces the reserved
          // box with the alt text, and without a rebuild the document keeps an
          // invisible gap where the picture will never appear.
          if (raster.failed) {
            this.inlineImagesMeasured.add(href);
            changed = true;
            continue;
          }
          if (!raster.decoded || !raster.naturalWidth || !raster.naturalHeight) {
            continue;
          }
          this.inlineImagesMeasured.add(href);
          // A square is what the span already reserved, so it needs no rebuild.
          // Compared as an aspect rather than a width so the answer does not depend
          // on which run the image happens to sit in.
          if (raster.naturalWidth !== raster.naturalHeight) changed = true;
          continue;
        }
        // Not an early return: every image has to be marked measured on this pass,
        // or one that decoded in the same tick is left to trigger a second rebuild.
        if (stale((token as Tokens.Generic).tokens as Token[] | undefined)) {
          changed = true;
        }
      }
      return changed;
    };

    let changed = false;
    for (const token of this.tokens) {
      if (token.type === 'heading') {
        if (stale((token as Tokens.Heading).tokens)) changed = true;
      } else if (token.type === 'table') {
        const table = token as Tokens.Table;
        for (const cell of table.header) {
          if (stale(cell.tokens)) changed = true;
        }
        for (const row of table.rows) {
          for (const cell of row) {
            if (stale(cell.tokens)) changed = true;
          }
        }
      }
    }
    return changed;
  }

  public override destroy(): void {
    // Set before the controller teardown below, which reaches this instance again
    // through the host's `release` hook: settlement work must know the tree is
    // going away rather than re-render into it.
    this.isDestroyed = true;
    this.optimisticTail = null;
    this.streamController?.destroy();
    for (const id of this.pendingWorkerIds) workerCallbacks.delete(id);
    this.pendingWorkerIds.clear();
    this.appendInFlight = false;
    this.appendPending = false;
    // A pending MathJax load holds settlement open, and its continuation now
    // returns early on `isDestroyed` without flushing. Clearing this first is
    // what lets the flush below actually release, instead of leaving an awaiting
    // `close()` pending forever against a torn-down tree.
    this.mathLoadPending = false;
    // Nothing will reply now, so release any settlement waiter rather than
    // leaving a `close()` pending against a destroyed instance.
    this.flushAppendSettledWaiters();
    // Unsubscribe from inline-formula decodes. The set is module-level and lives
    // as long as the page, so leaving the closure in it would retain this whole
    // entity tree after destroy.
    if (this.inlineMathRepaint) {
      unsubscribeInlineMathRaster(this.inlineMathRepaint);
      this.inlineMathRepaint = undefined;
    }
    if (this.inlineImageRemeasure) {
      unsubscribeInlineImageRaster(this.inlineImageRemeasure);
      this.inlineImageRemeasure = undefined;
    }
    // Release this instance's prior-raws entry in the (shared) worker, so a page
    // that creates and drops many blocks doesn't retain their raws forever.
    markdownWorker?.postMessage({
      instance: this.workerInstanceId,
      dispose: true,
    });
    super.destroy();
  }

  /**
   * Streaming and parse state — the markdown streaming inspector.
   *
   * Source length, chunk count, worker in-flight state, and the stable-prefix
   * versus changed-tail split. That last ratio is the one worth watching: it is
   * how you tell incremental reuse is working from outside, and nothing else
   * surfaces it. A ratio near 1 means the worker matched almost the whole prefix
   * and rebuilt only the tail's entities; near 0 means almost nothing was reused.
   * Neither says anything about lexer CPU, which is O(document) per append — that
   * is what the Parser cost group reports.
   */
  public override getDevtoolsDescriptor(): DevtoolsDescriptor {
    const s = this.streamStats;
    const diffedTokens = s.tokensPrefixMatched + s.tokensReturned;
    const tokenPrefixReuseRatio = diffedTokens > 0 ? s.tokensPrefixMatched / diffedTokens : 0;
    return {
      kind: 'Markdown',
      groups: [
        {
          label: 'Source',
          fields: [
            {
              label: 'sourceLength',
              value: this.rawMarkdown.length,
              readOnly: true,
            },
            {
              label: 'topLevelTokens',
              value: this.tokens.length,
              readOnly: true,
            },
            {
              label: 'childEntities',
              value: this.content.children.length,
              readOnly: true,
            },
            { label: 'selectable', value: this.selectable },
          ],
        },
        {
          label: 'Streaming',
          fields: [
            { label: 'appends', value: s.appends, readOnly: true },
            {
              label: 'workerResponses',
              value: s.workerResponses,
              hint: 'Fewer than appends means chunks were coalesced while a request was in flight',
              readOnly: true,
            },
            {
              label: 'appendInFlight',
              value: this.appendInFlight,
              hint: 'One lex request at a time; the delta protocol requires it',
              readOnly: true,
            },
            {
              label: 'appendPending',
              value: this.appendPending,
              readOnly: true,
            },
            {
              label: 'workerMsAvg',
              value:
                s.workerResponses > 0
                  ? Math.round((s.workerMs / s.workerResponses) * 100) / 100
                  : 0,
              hint: 'Mean lex round trip, dispatch to applied',
              readOnly: true,
            },
            {
              label: 'workerMsMax',
              value: Math.round(s.workerMsMax * 100) / 100,
              hint: 'Worst single round trip — this is the one a dropped frame comes from',
              readOnly: true,
            },
          ],
        },
        {
          label: 'Delta shape',
          fields: [
            {
              label: 'stablePrefixChars',
              value: s.stablePrefixChars,
              hint: 'Source characters the worker matched and did not re-read, on the last append',
              readOnly: true,
            },
            {
              label: 'changedTailChars',
              value: s.changedTailChars,
              hint: 'Source characters whose tokens changed on the last append. Growing with the document means the delta is not a delta',
              readOnly: true,
            },
            {
              label: 'entitiesReused',
              value: s.entitiesReused,
              hint: 'Child entities kept untouched across reconciles',
              readOnly: true,
            },
            {
              label: 'entitiesRebuilt',
              value: s.entitiesRebuilt,
              hint: 'Child entities destroyed and reconstructed',
              readOnly: true,
            },
            {
              label: 'inPlaceUpdates',
              value: s.inPlaceUpdates,
              hint: 'setCode/setSpans on the growing last block — the streaming fast path',
              readOnly: true,
            },
          ],
        },
        {
          label: 'Incremental reuse',
          fields: [
            {
              label: 'tokensPrefixMatched',
              value: s.tokensPrefixMatched,
              hint: 'Sum of matchLen: leading tokens whose raw was unchanged, so their entities were kept',
              readOnly: true,
            },
            {
              label: 'tokensReturned',
              value: s.tokensReturned,
              hint: 'Sum of returned tail lengths: the changed suffix the worker cloned back',
              readOnly: true,
            },
            {
              label: 'tokenPrefixReuseRatio',
              value: Math.round(tokenPrefixReuseRatio * 1000) / 1000,
              hint: 'matched / (matched + returned). Near 1 means small transfers and high entity reuse. Lexing saved is measured separately — see sourceCharsLexed',
              readOnly: true,
            },
          ],
        },
        {
          label: 'Parser cost',
          fields: [
            {
              label: 'lexerMs',
              value: Math.round(s.lexerMs * 10) / 10,
              hint: 'Total ms inside marked.lexer() — the unstable tail, every append',
              readOnly: true,
            },
            {
              label: 'sourceCharsLexed',
              value: s.sourceCharsLexed,
              hint: 'Characters lexed, summed over appends. O(n*window) with a stable block boundary; ~O(n^2) if this instance degraded (display math or a link reference definition)',
              readOnly: true,
            },
          ],
        },
      ],
      notes:
        s.workerResponses === 0 && s.appends > 0
          ? [
              'No worker responses yet: either the worker is unavailable and parsing ran synchronously on the main thread, or the first request is still in flight.',
            ]
          : tokenPrefixReuseRatio > 0 && tokenPrefixReuseRatio < 0.5
            ? [
                `Only ${Math.round(tokenPrefixReuseRatio * 100)}% of tokens matched the prior prefix, so most of the token array is being returned and its entities rebuilt every chunk. The lexer is a separate cost — check sourceCharsLexed to see whether the stable boundary is also failing to advance.`,
              ]
            : s.changedTailChars > 0 &&
                this.rawMarkdown.length > 0 &&
                s.changedTailChars / this.rawMarkdown.length > 0.5
              ? [
                  `The last append changed ${s.changedTailChars} of ${this.rawMarkdown.length} characters. A changed tail that grows with the document means the delta is not a delta, so almost every entity is rebuilt per chunk.`,
                ]
              : undefined,
    };
  }

  /** Enable or disable User Timing for subsequent parses. */
  public setUserTiming(enabled: boolean): this {
    this._userTiming = enabled;
    return this;
  }

  /** Whether Markdown parse User Timing is enabled. */
  public get userTiming(): boolean {
    return this._userTiming;
  }

  /** Enable or disable native selection for existing and future Markdown text. */
  public setSelectable(selectable: boolean): this {
    this.selectable = selectable;
    const apply = (entity: Entity): void => {
      const candidate = entity as Entity & {
        setSelectable?: (value: boolean) => unknown;
      };
      candidate.setSelectable?.(selectable);
      for (const child of entity.children) apply(child);
    };
    for (const child of this.content.children) apply(child);
    this.scene?.markDirty();
    return this;
  }

  /** Append a markdown chunk incrementally. Reuses unchanged prefix entities. */
  public appendMarkdown(chunk: string): this {
    // An onStable callback is handed a snapshot of the finished document; mutating
    // that document from inside it would make the snapshot a lie and re-enter the
    // reconciler from within its own settlement path.
    this.assertNotInStableCallback('appendMarkdown');
    this.streamController?.flush();
    return this.appendMarkdownCore(chunk);
  }

  private appendMarkdownCore(chunk: string): this {
    const before = this.rawMarkdown.length;
    this.consumeFrontMatter(chunk);
    this.streamStats.appends++;

    // The chunk went entirely into the front matter hold, so there is no new body
    // text to lex. Dispatching anyway would post a zero-length delta and spend a
    // round trip to be told the token list is unchanged.
    if (this.rawMarkdown.length === before) return this;

    return this.relexBody();
  }

  /**
   * Lex {@link rawMarkdown} and reconcile, via the worker when one exists.
   *
   * Split out of {@link appendMarkdownCore} because end-of-stream front matter
   * release has to reach the same path: text held back while the front matter
   * question was open becomes body text without any chunk being appended.
   */
  private relexBody(): this {
    if (!markdownWorker) {
      // No worker (unsupported, failed to construct, or crashed and was dropped):
      // lex here. Nothing the worker holds is advanced by this, so a later
      // request — if a worker ever exists again — must resend the full text.
      this.workerSourceLen = 0;
      const newTokens = lexMarkdown(this.rawMarkdown, this._userTiming);
      this.updateTokens(newTokens);
      return this;
    }

    if (this.appendInFlight) {
      // `this.rawMarkdown` already has this chunk folded in — the next
      // dispatch picks it up naturally, no separate buffer needed.
      this.appendPending = true;
      return this;
    }
    this.dispatchAppend();
    return this;
  }

  /**
   * Post one lex request for the accumulated text.
   *
   * Two shapes. Steady state sends a DELTA — `{ append }` plus the expected total
   * length — because the worker keeps both this instance's prior token raws and
   * the document source itself (keyed by `workerInstanceId` + `tokenVersion`).
   * Re-sending the document each chunk made main->worker transfer O(document) per
   * chunk, i.e. O(N²) over a stream, and that cost is paid on the main thread:
   * `postMessage` structured-clones the string synchronously before the worker
   * ever wakes. `resync` forces the FULL shape instead — the whole text plus the
   * prior raw list — and is used for the first request for this instance, after
   * anything the worker did not produce (`setContent`, a sync-fallback parse), and
   * whenever the worker reports it cannot trust what it holds (`needResync`).
   */
  private dispatchAppend(resync = false): void {
    if (!markdownWorker) return;
    this.appendInFlight = true;
    const id = workerIdCounter++;
    // Snapshot now — this is the array the worker's `matchLen` is relative
    // to, and it must stay fixed until this exact response is applied (see
    // the field comment on `appendInFlight` for why that requires
    // coalescing rather than tracking `this.tokens` live).
    const oldTokensSnapshot = this.tokens;
    const baseVersion = this.tokenVersion;
    const dispatchedAt = now();
    // The length this request brings the worker's source to. Captured at dispatch
    // because `this.rawMarkdown` can grow again (coalesced appends) before the
    // response lands, and what the worker then holds is this, not the latest.
    const sentLength = this.rawMarkdown.length;
    // A delta is only valid if the worker holds a prefix of the current source.
    // `workerSourceLen === 0` means it holds nothing for this instance.
    const canSendDelta = !resync && this.workerSourceLen > 0 && this.workerSourceLen <= sentLength;
    this.pendingWorkerIds.add(id);
    workerCallbacks.set(id, {
      cb: (matchLen, tail, local = false, lex) => {
        this.pendingWorkerIds.delete(id);
        this.streamStats.workerResponses++;
        this.streamStats.tokensPrefixMatched += matchLen;
        this.streamStats.tokensReturned += tail.length;
        if (lex) {
          this.streamStats.lexerMs += lex.lexerMs;
          this.streamStats.sourceCharsLexed += lex.sourceCharsLexed;
        }
        const elapsed = now() - dispatchedAt;
        this.streamStats.workerMs += elapsed;
        if (elapsed > this.streamStats.workerMsMax) this.streamStats.workerMsMax = elapsed;
        // `local` means this result came from the main-thread fallback lexer, so
        // the worker never saw this source and whatever it holds is now behind.
        // Forcing the next request to resync is the only safe reading: a delta
        // applied to a stale cached source would lex text the caller never has.
        this.workerSourceLen = local ? 0 : sentLength;
        // Character counts, not token counts: a stable prefix of 40 tokens says
        // nothing about how much text the worker skipped, and the O(document) vs
        // O(appended) question is about characters.
        let prefixChars = 0;
        for (let i = 0; i < matchLen; i++) prefixChars += oldTokensSnapshot[i]?.raw.length ?? 0;
        this.streamStats.stablePrefixChars = prefixChars;
        this.streamStats.changedTailChars = this.rawMarkdown.length - prefixChars;
        this.appendInFlight = false;
        const newTokens = [...oldTokensSnapshot.slice(0, matchLen), ...tail] as TokensList;
        // The worker's matchLen is exactly the prefix it kept, and `newTokens` is
        // built from that same slice, so it is correct by construction here.
        this.updateTokens(newTokens, matchLen);
        if (this.appendPending) {
          this.appendPending = false;
          this.dispatchAppend();
        }
        // Last, deliberately: `appendInFlight` was cleared above and the
        // re-dispatch just set it back to `true` if more text had arrived — both
        // synchronously, so nothing watching the flag itself could see the gap.
        // Checking only here is what makes a settlement waiter wait through a
        // coalesced re-dispatch instead of resolving one chunk early.
        this.flushAppendSettledWaiters();
      },
      // The worker can't trust what it holds for this request; retry it once with
      // the full text and raws attached. `this.tokens` is untouched (no
      // updateTokens ran), so the retry's snapshot and version still line up.
      onNeedResync: () => {
        this.pendingWorkerIds.delete(id);
        this.appendInFlight = false;
        // Whatever the worker had is unusable, so the retry must not send a delta.
        this.workerSourceLen = 0;
        this.dispatchAppend(true);
      },
      // Neither the worker nor the fallback lexer could produce tokens for this
      // request, so `this.tokens` stays as it was. Only the in-flight bookkeeping
      // needs unwinding — including any coalesced chunk waiting behind it, which
      // still has to be attempted.
      onDropped: () => {
        this.pendingWorkerIds.delete(id);
        this.appendInFlight = false;
        // Nothing proved the worker holds this source; force the next request full.
        this.workerSourceLen = 0;
        if (this.appendPending) {
          this.appendPending = false;
          this.dispatchAppend(true);
        }
        this.flushAppendSettledWaiters();
      },
      text: this.rawMarkdown,
      userTiming: this._userTiming,
    });
    markdownWorker.postMessage({
      id,
      instance: this.workerInstanceId,
      baseVersion,
      userTimingName: this._userTiming ? VECTO_USER_TIMING.markdown.parse : undefined,
      ...(canSendDelta
        ? {
            append: this.rawMarkdown.slice(this.workerSourceLen),
            // What the worker's source must total once it applies this append. It
            // rejects a mismatch with one resync rather than lexing a source that
            // has diverged from this one — a dropped or duplicated chunk would
            // otherwise return a matchLen against tokens this instance never had.
            expectedLength: sentLength,
          }
        : {
            text: this.rawMarkdown,
            oldRaws: oldTokensSnapshot.map((t) => t.raw),
          }),
    });
  }

  /**
   * Spans for one paragraph token exactly as `marked` produced it.
   *
   * The literal baseline: what every release renders, and what an optimistic
   * guess is unwound back to.
   */
  private literalParagraphSpans(token: Tokens.Paragraph): StyledSpan[] {
    const spans: StyledSpan[] = [];
    if (token.tokens && token.tokens.length > 0) {
      collectSpans(token.tokens, {}, this.theme, spans, undefined, this.abbreviations);
    }
    if (spans.length === 0) spans.push({ text: token.text });
    return spans;
  }

  /**
   * Update a reused blockquote's tail child in place, or report that it cannot be.
   *
   * The render arm builds `container[border, innerStack]` where every inner block
   * sits in its own single-child `wrapper`, so the tail entity is
   * `innerStack.children.at(-1).children[0]`. Only the LAST inner block may be
   * updated: the inner token list is prefix-stable exactly like the top level (a
   * growing quote keeps its earlier blocks byte-identical), so anything before the
   * tail is untouched and anything more complicated than a changed tail falls back
   * to the caller's rebuild.
   *
   * Returns `false` without mutating anything when the shape is not the simple
   * grow-the-tail case, which is the signal for the caller to rebuild. Every early
   * return has to leave the entity untouched, or a rejected reuse would leave a
   * half-updated quote on screen.
   */
  /**
   * Build one list item's spans: inline content plus its marker.
   *
   * Shared by the `list` render arm and the streamed-reuse path below, because
   * the two must produce byte-identical spans — a reused list that disagreed with
   * a rebuilt one about its marker or its entity decoding would make a streamed
   * document differ from the same source pasted at once.
   */
  /**
   * Inline spans for one table cell.
   *
   * Always returns at least one span. A cell whose markup collapses to nothing —
   * an empty cell, but also a bare `<span>`, an image, or an HTML comment, none
   * of which `collectSpans` emits for — falls back to its decoded source text,
   * which is what the previous string-returning path rendered. That guarantee is
   * what lets every cell be a `RichText`: an empty cell would otherwise become a
   * `Text`, and since `Text` has `setText` while `RichText` has `setSpans` and
   * nothing converts between them, a cell that starts empty and later gains
   * content could not be updated in place. A streamed table needs exactly that,
   * because `marked` materializes a partial row as a full row of empty cells and
   * then fills them one at a time.
   */
  private tableCellSpans(cell: Tokens.TableCell, t: Required<MarkdownTheme>): StyledSpan[] {
    const spans: StyledSpan[] = [];
    collectSpans(cell.tokens, {}, t, spans, undefined, this.abbreviations);
    if (spans.length === 0) spans.push({ text: decodeEntities(cell.text) });
    return spans;
  }

  /**
   * Spans for one run of consecutive non-image inline tokens.
   *
   * A paragraph holding an image renders as a `Stack` of alternating text runs
   * and images, and this is one text run. Shared by the render arm and
   * {@link updateImageParagraph} so a reused run cannot drift from a rebuilt one.
   *
   * The empty fallback mirrors `renderInlineToRichText('', …)`, which the render
   * arm passed for these runs: a run is only created when it has at least one
   * token, so the fallback is for tokens that emit no spans at all rather than
   * for an empty run.
   */
  private inlineRunSpans(tokens: Token[], t: Required<MarkdownTheme>): StyledSpan[] {
    const spans: StyledSpan[] = [];
    if (tokens.length > 0) collectSpans(tokens, {}, t, spans, undefined, this.abbreviations);
    if (spans.length === 0) spans.push({ text: '' });
    return spans;
  }

  /** One text run of an image-bearing paragraph, as both paths build it. */
  private inlineRunRichText(
    tokens: Token[],
    availableWidth: number,
    t: Required<MarkdownTheme>,
  ): RichText {
    return new RichText(this.inlineRunSpans(tokens, t), {
      font: `${t.fontSize}px ${t.bodyFont}`,
      color: t.textColor,
      maxWidth: availableWidth,
      linkColor: t.linkColor,
      selectable: this.selectable,
      onLinkClick: this.onLinkClick,
    });
  }

  /**
   * One image inside a paragraph, sized by a guess until its bitmap decodes.
   *
   * Width and height start at a 16:10 guess because the intrinsic size is not
   * known until the browser has the bitmap; `onLoad` corrects both from
   * `naturalWidth`/`naturalHeight`. Extracted from the render arm so the streamed
   * path reuses this exact entity rather than constructing a second variant.
   *
   * `markDirty()` is unconditional, matching the display-math sibling. It used
   * to sit inside the `naturalWidth && naturalHeight` check, which meant a
   * source that loads successfully while reporting a zero dimension left the
   * scene un-notified. `Image` sets `loaded` before invoking this callback, so
   * its `render()` starts drawing the bitmap either way — the cost was not a
   * stale placeholder but a box frozen at the guess: measured on Chromium and
   * Firefox, an `<svg width="0" height="0">` paragraph image kept 800x480 of
   * reserved layout forever while a normal raster corrected to 80x60. An
   * `onDemand` scene repaints only when marked, so nothing reclaimed it.
   *
   * The box is deliberately left at the guess when the bitmap reports zero.
   * Collapsing it to 0x0 would make the paragraph reflow correctly but would
   * also silently delete a reserved region on the strength of one browser
   * quirk, and `Image.render()` still blits whatever the bitmap holds. Sizing
   * policy for a zero-dimension source is a separate decision from notifying
   * the scene, which is the actual defect here.
   */
  /**
   * Wraps a block in its copy / download controls, or returns it untouched.
   *
   * The controls are built lazily through `make` so a document with
   * `blockAffordances` off pays nothing — not the closures, not the measurement
   * `BlockAffordanceButton` does in its constructor.
   */
  private withBlockAffordances(block: Entity, make: () => BlockAffordanceButton[]): Entity {
    if (!this.blockAffordances) return block;
    const controls = make();
    return controls.length > 0 ? new BlockWithAffordances(block, controls) : block;
  }

  /** Copy and download controls for one fenced code block. */
  private codeBlockAffordances(source: string, lang: string): BlockAffordanceButton[] {
    const opts = this.affordanceButtonOptions();
    return [
      new BlockAffordanceButton('Copy code', 'Copied', () => this.writeClipboard(source), opts),
      new BlockAffordanceButton(
        'Download code',
        'Saved',
        () => this.saveFile(`code.${extensionForLanguage(lang)}`, source, mimeForLanguage(lang)),
        opts,
      ),
    ];
  }

  /** Copy (as Markdown) and download (as CSV) controls for one table. */
  private tableAffordances(tblToken: Tokens.Table): BlockAffordanceButton[] {
    const content = tableContentOf(tblToken);
    const opts = this.affordanceButtonOptions();
    return [
      // Markdown rather than CSV for the clipboard: the reader copied it out of a
      // Markdown document and the overwhelmingly likely destination is another
      // one. CSV is what the download is for, where a spreadsheet is the target.
      new BlockAffordanceButton(
        'Copy table',
        'Copied',
        () => this.writeClipboard(tableToMarkdown(content)),
        opts,
      ),
      new BlockAffordanceButton(
        'Download table',
        'Saved',
        () => this.saveFile('table.csv', tableToCsv(content), 'text/csv;charset=utf-8'),
        opts,
      ),
    ];
  }

  /**
   * Button styling for the affordances, derived from the document theme.
   *
   * Themed rather than hardcoded so a light-theme document does not get the dark
   * default palette. `focusColor` is set explicitly from the theme's accent
   * because `Button`'s default cyan is tuned for the dark palette and reads as
   * off-brand elsewhere — while a focus ring is the one affordance a keyboard
   * user cannot do without.
   */
  private affordanceButtonOptions(): ButtonOptions {
    return {
      font: `600 12px ${this.theme.bodyFont}`,
      padding: 6,
      radius: 6,
      bg: this.theme.codeBgColor,
      hoverBg: this.theme.tableHeaderBgColor,
      color: this.theme.textColor,
      focusColor: this.theme.codeColor,
    };
  }

  private paragraphImage(imgToken: Tokens.Image, availableWidth: number): Image {
    const initialWidth = Math.min(800, availableWidth);
    const initialHeight = Math.round(initialWidth * 0.6); // Guess 16:10 aspect ratio initially
    const img = new Image(imgToken.href, {
      width: initialWidth,
      height: initialHeight,
      alt: imgToken.text,
      radius: this.theme.imageRadius,
      onLoad: () => {
        const bmp = (img as any).bitmap;
        if (bmp && bmp.naturalWidth && bmp.naturalHeight) {
          const aspect = bmp.naturalHeight / bmp.naturalWidth;
          img.width = Math.min(bmp.naturalWidth, availableWidth);
          img.height = Math.round(img.width * aspect);
        }
        this.scene?.markDirty();
      },
    });
    return img;
  }

  /** One table cell entity, shared by the render arm and the streamed-table path. */
  private tableCellRichText(
    cell: Tokens.TableCell,
    header: boolean,
    t: Required<MarkdownTheme>,
  ): RichText {
    return new RichText(this.tableCellSpans(cell, t), {
      font: `${t.tableFontSize}px ${t.bodyFont}`,
      color: header ? t.headingColor : t.textColor,
      baseStyle: header ? { bold: true } : undefined,
      linkColor: t.linkColor,
      selectable: this.selectable,
      onLinkClick: this.onLinkClick,
    });
  }

  /**
   * Token types a list item's fast path can render as one `RichText`.
   *
   * An ALLOWLIST, deliberately, following `markstream-vue`'s
   * `SIMPLE_INLINE_TYPES` (`SimpleInlineRenderer/simpleInline.ts:15-31`): a block
   * type is excluded by OMISSION, so a token this renderer has never heard of
   * falls out of the fast path automatically instead of being silently flattened
   * to its raw text. A denylist fails the other way, and the failure is quiet —
   * a formula painted as literal TeX rather than an error — which is why this
   * defect survived so long.
   *
   * Deliberately small, because a list item's DIRECT children are far less varied
   * than they look. Probed against marked 18.0.7: every inline construct
   * (`strong`, `em`, `del`, `codespan`, `link`, `image`, `br`, `escape`, `html`,
   * `inlineMath`) arrives nested one level DEEPER, inside a container whose own
   * type is `text` — so a tight item's direct child list is `text` and nothing
   * else. Listing those inline types here would be dead code.
   *
   * `space` and `checkbox` are included because both are inert here. A blank line
   * between an item's paragraph and its block sibling produces a `space`, and
   * marked unshifts a `checkbox` into every TIGHT GFM task item — the box itself
   * is drawn from `item.task`/`item.checked` by `listItemSpans`, so the token
   * renders nothing on its own. Omitting `checkbox` sent every task item down the
   * block path and moved its marker into a nested entity, which broke four
   * task-list assertions in `Markdown.test.ts`.
   */
  private static readonly INLINE_ITEM_TOKENS: ReadonlySet<string> = new Set([
    'text',
    'space',
    'checkbox',
  ]);

  /**
   * Does this item consist purely of inline content?
   *
   * True keeps the single-`RichText` fast path, which is not merely an
   * optimization: `updateStreamedList` reuses `stack.children[i]` by calling
   * `setSpans` on it, so an item that becomes a `Stack` forfeits streamed reuse
   * for its entire list. Only pay for a block container when an item holds a
   * block.
   *
   * A lone `paragraph` counts as inline. A LOOSE list re-lexes every item's
   * inline content from `text` to `paragraph` — adding one blank line anywhere
   * flips `token.loose` for the whole list — so treating a single paragraph as a
   * block would drop the fast path for every item of every loose list, the common
   * shape in real prose, for no rendering benefit.
   */
  private itemIsInlineOnly(item: Tokens.ListItem): boolean {
    const children = item.tokens;
    if (!children || children.length === 0) return true;
    // An image is inline in Markdown but not in this renderer: `listItemRichText`
    // builds one `RichText`, which has no image support, so an item holding one
    // has to take the block path or the image is silently dropped. Checked before
    // the lone-paragraph shortcut, which would otherwise return true first.
    if (containsImage(children)) return false;
    if (children.length === 1 && children[0].type === 'paragraph') return true;
    return children.every((child) => Markdown.INLINE_ITEM_TOKENS.has(child.type));
  }

  /**
   * Build a list item that holds block-level children.
   *
   * The item becomes a vertical `Stack`: its leading inline run (carrying the
   * marker) first, then every remaining child rendered through the same
   * `renderToken` the document level uses, indented to clear the marker.
   *
   * Recursing rather than special-casing the types we know about is the point — a
   * display formula, a fence, a table, a blockquote, a nested list, an `hr` and a
   * second paragraph all render exactly as they would at indent 0, and a block
   * type added later works here for free.
   *
   * Only the FIRST child can be the lead. Everything after it becomes a block,
   * including a second `paragraph`: an item's two paragraphs are two blocks, and
   * folding them into the lead run would concatenate them into one line with no
   * separation.
   *
   * The lead `RichText` is emitted even when the item has no inline text, because
   * it carries the marker — an item that is nothing but a formula still shows its
   * bullet or ordinal.
   */
  private listItemBlockStack(
    token: Tokens.List,
    index: number,
    availableWidth: number,
    t: Required<MarkdownTheme>,
  ): Entity {
    const item = token.items[index];
    const children = item.tokens ?? [];
    const stack = new Stack({ direction: 'vertical', gap: t.listItemGap });

    // The lead run: the item's own inline content, or nothing but a marker.
    const first = children[0];
    const firstIsInline = Boolean(first) && (first.type === 'text' || first.type === 'paragraph');
    // A lead carrying a nested image keeps its prose but surrenders the image to
    // the block loop, which routes it through the paragraph arm. The image cannot
    // stay: the lead is one `RichText`, which has no image support, and it cannot
    // simply be excluded from the lead either — an empty `leadChildren` makes
    // `listItemSpans` fall back to the item's RAW `text`, so `- item ![a](u)`
    // rendered its own Markdown source as the marker run, duplicated above the
    // correctly-split block. Stripping keeps the marker, keeps `"item "`, and
    // leaves exactly the images to the loop.
    const leadHasImage =
      firstIsInline && containsImage((first as Tokens.Generic).tokens as Token[]);
    const leadChildren = firstIsInline ? [leadHasImage ? stripImages(first) : first] : [];
    // What the block loop must still render from the first child: the images the
    // lead gave up, and nothing else.
    const leadImages = leadHasImage ? imagesOf((first as Tokens.Generic).tokens as Token[]) : [];
    // Built through `listItemRichText` on a token whose item holds only the lead
    // children, so the lead run is constructed identically to a fast-path item —
    // same font, same marker placement, same reading-direction handling — rather
    // than by a second copy of that construction which could drift from it.
    const leadToken: Tokens.List = {
      ...token,
      items: token.items.map((it, i) => (i === index ? { ...it, tokens: leadChildren } : it)),
    };
    stack.add(this.listItemRichText(leadToken, index, availableWidth, t));

    // Everything after the lead, indented past the marker. Same wrapper shape
    // blockquote uses (`MarkdownContainer` + `el.x`), because `Stack` treats `x`
    // as layout-controlled and overwrites a child's own offset
    // (`Stack.appendFast` assigns `child.x = 0` for a vertical stack).
    const indent = Math.round(t.fontSize);
    const childMetrics: BlockMetrics = {
      marginBefore: 0,
      marginAfter: 0,
      indentStart: indent,
      availableWidth: Math.max(1, availableWidth - indent),
    };
    // The images the lead surrendered, each as its own block. Emitted before the
    // item's remaining children so source order is preserved: they came from the
    // FIRST child.
    for (const image of leadImages) {
      const el = this.paragraphImage(image, childMetrics.availableWidth);
      const wrapper = new MarkdownContainer();
      el.x = indent;
      wrapper.add(el);
      stack.add(wrapper);
    }

    for (let i = leadChildren.length; i < children.length; i++) {
      const el = this.renderTokenWithMetrics(children[i], childMetrics);
      if (!el) continue;
      const wrapper = new MarkdownContainer();
      el.x = indent;
      wrapper.add(el);
      wrapper.width = el.width + indent;
      wrapper.height = el.height;
      stack.add(wrapper);
    }

    return stack;
  }

  private listItemSpans(token: Tokens.List, index: number): StyledSpan[] {
    const item = token.items[index];
    const num = Number(token.start ?? 1) + index;
    // Build the inline content spans first; the marker is placed after, on
    // the side that matches the item's reading direction.
    const contentSpans: StyledSpan[] = [];
    if (item.tokens && item.tokens.length > 0) {
      // List item tokens are block-level; dig into paragraph children
      for (const inner of item.tokens) {
        if (inner.type === 'text' && 'tokens' in inner && (inner as any).tokens?.length) {
          collectSpans(
            (inner as any).tokens,
            {},
            this.theme as Required<MarkdownTheme>,
            contentSpans,
            undefined,
            this.abbreviations,
          );
        } else if ('tokens' in inner && (inner as any).tokens?.length) {
          collectSpans(
            (inner as any).tokens,
            {},
            this.theme as Required<MarkdownTheme>,
            contentSpans,
            undefined,
            this.abbreviations,
          );
        } else if ('text' in inner) {
          contentSpans.push({ text: decodeEntities((inner as any).text) });
        }
      }
    } else {
      contentSpans.push({ text: decodeEntities(item.text) });
    }

    // Place the marker on the reading-start side. An RTL item must show
    // its marker at the visual RIGHT; a leading neutral bullet would
    // bidi-reorder to the visual LEFT. Appending the marker as a TRAILING
    // span fixes it: `" •"` reorders to visual `"• …"`, and `" .N"` to
    // `"N. …"` — both flush-right in reading order. LTR keeps the marker
    // leading as before.
    // A GFM task item shows a checkbox where the bullet would go — GitHub's own
    // stylesheet suppresses the bullet for a task list — while an ordered task
    // item keeps its number and gains a box after it.
    //
    // The box is a glyph in the same run rather than a drawn entity because a
    // list item is ONE `RichText`. Splitting it into a Stack of [box, text]
    // would lose both the reading-direction handling below and the span identity
    // the streamed path depends on (see this method's docstring).
    const box = item.task ? (item.checked ? '\u2611 ' : '\u2610 ') : '';
    const leadingMarker = token.ordered ? `${num}. ${box}` : box || '• ';
    const trailingMarker = token.ordered ? ` ${box}.${num}` : box ? ` ${box.trimEnd()}` : ' \u2022';

    const itemIsRtl = BidiResolver.getBaseLevel(contentSpans.map((s) => s.text).join('')) % 2 === 1;
    return itemIsRtl
      ? [...contentSpans, { text: trailingMarker }]
      : [{ text: leadingMarker }, ...contentSpans];
  }

  /** Construct the `RichText` for one list item. */
  private listItemRichText(
    token: Tokens.List,
    index: number,
    availableWidth: number,
    t: Required<MarkdownTheme>,
  ): RichText {
    // No `x` offset and no width reserved for one. Until 2026-07-30 this set
    // `itemRt.x = 12 // Indent` and passed `availableWidth - 24`, but the indent
    // was dead: `Stack.appendFast` assigns `child.x = 0` for a vertical stack
    // (packages/ui/src/Stack.ts:160) and `Stack` declares `x`/`y` as
    // layout-controlled, so `add()` overwrote it. Probed: every item's `x` was 0.
    // The 24px reserve therefore compensated for an indent that never rendered,
    // shrinking the wrap width for no reason. A list nested in a blockquote is
    // indented by the quote's own wrapper (`el.x = indentStart`), not here.
    return new RichText(this.listItemSpans(token, index), {
      font: `${t.fontSize}px ${t.bodyFont}`,
      color: t.textColor,
      maxWidth: availableWidth,
      linkColor: t.linkColor,
      selectable: this.selectable,
      onLinkClick: this.onLinkClick,
    });
  }

  /**
   * Reuse a streamed list's `Stack` instead of rebuilding every item.
   *
   * Returns `false` to mean "rebuild instead", exactly like
   * {@link updateBlockquoteTail}, and every rejection path leaves the entity
   * untouched so a refused reuse cannot leave a half-updated list on screen.
   *
   * This is the shape a stream actually produces: items are APPENDED, and only
   * the last one grows. That matters for the ordinal marker, which is
   * position-derived (`start + index`) — under append an already-rendered item's
   * index never changes, so its marker stays correct. A mid-list insertion would
   * shift every later ordinal, but no stream produces one.
   *
   * Two traps this guards, both found by probing marked 18.0.7 rather than by
   * reading:
   *
   * - **A retained item's `raw` is NOT stable.** `items[1].raw` goes `"- two"` ->
   *   `"- two\\n"` when item 3 arrives, so a byte-equality guard on `raw` fails on
   *   every chunk and the fast path would never fire. `text` is stable; compare
   *   that.
   * - **A tight list can become loose.** Adding a blank line flips
   *   `token.loose`, which re-lexes every item's children from `text` to
   *   `paragraph`. Item 0's own `text` is unchanged, so a naive guard would reuse
   *   and keep stale spans. Bail when `loose` flips.
   */
  private updateStreamedList(stack: Entity, oldToken: Tokens.List, newToken: Tokens.List): boolean {
    if (!(stack instanceof Stack)) return false;
    // A list may only have grown. Fewer items means an edit, not a stream.
    if (newToken.items.length < oldToken.items.length || oldToken.items.length === 0) return false;
    // `ordered` and `start` feed every marker; `loose` changes how items lex.
    if (oldToken.ordered !== newToken.ordered) return false;
    if ((oldToken.start ?? 1) !== (newToken.start ?? 1)) return false;
    if (oldToken.loose !== newToken.loose) return false;
    // The stack must be the one the render arm built for these items.
    if (stack.children.length !== oldToken.items.length) return false;

    // Every item before the last retained one must be unchanged. Compare `text`,
    // not `raw` — see the trap note above.
    const lastRetained = oldToken.items.length - 1;
    // Alongside the text check, confirm each retained entity is still the KIND its
    // token implies. `text` equality is a weaker guarantee for a block-bearing item
    // than for an inline one, because a block child's content need not appear in the
    // item's `text` at all; if the two ever disagree, rebuild rather than reuse an
    // entity of the wrong shape.
    for (let i = 0; i < lastRetained; i++) {
      if (oldToken.items[i].text !== newToken.items[i].text) return false;
      const isStack = stack.children[i] instanceof Stack;
      if (isStack !== !this.itemIsInlineOnly(newToken.items[i])) return false;
    }

    // Same derivation renderToken uses, so an appended item is measured exactly
    // as a rebuilt one would be. A top-level list has no activeBlockMetrics, so
    // this is `maxWidth`; the fallback is spelled out rather than assumed.
    const availableWidth = this.activeBlockMetrics?.availableWidth ?? this.maxWidth;
    const t = this.theme;

    // The last retained item may have grown; rewrite its spans in place. An item
    // that now holds a block child is no longer a single `RichText` and cannot be
    // updated by rewriting spans — rebuild instead, which is also what promotes it
    // from the fast path the moment its `$$` or fence closes.
    const tailEntity = stack.children[lastRetained];
    if (oldToken.items[lastRetained].text !== newToken.items[lastRetained].text) {
      if (!this.itemIsInlineOnly(newToken.items[lastRetained])) return false;
      if (!('setSpans' in tailEntity)) return false;
      (tailEntity as Entity & { setSpans: (s: StyledSpan[]) => unknown }).setSpans(
        this.listItemSpans(newToken, lastRetained),
      );
    }

    // Then append whatever arrived after it, tiered the same way the render arm is.
    for (let i = oldToken.items.length; i < newToken.items.length; i++) {
      stack.add(
        this.itemIsInlineOnly(newToken.items[i])
          ? this.listItemRichText(newToken, i, availableWidth, t)
          : this.listItemBlockStack(newToken, i, availableWidth, t),
      );
    }

    // `add()` already maintained the stack's box via its append fast path, but a
    // grown tail item did not, so resync on that. Safe when nothing was appended
    // too: resizeLastChild falls back to a full layout() when its invariants do
    // not hold.
    const last = stack.children.at(-1);
    if (last) stack.resizeLastChild(last);
    return true;
  }

  /**
   * Reuse a streamed image-bearing paragraph's `Stack` instead of rebuilding it.
   *
   * Returns `false` to mean "rebuild instead", and every rejection happens before
   * any mutation, so a refused reuse leaves the entity exactly as it was.
   *
   * This was the last silent fallthrough in the in-place reuse path. A paragraph
   * holding an image renders as a `Stack` of alternating text runs and images
   * rather than one `RichText`, so it has no `setSpans` and failed the ordinary
   * paragraph gate — with no `else`, which is what made the miss invisible:
   * `inPlaceUpdates` stayed flat while `entitiesRebuilt` climbed. Measured on a
   * six-chunk stream, `inPlaceUpdates` 0 / `entitiesRebuilt` 4 with an image
   * against 4 / 0 for the identical shape without one. Every rebuild also
   * re-created the `Image`, discarding its decoded bitmap and its corrected
   * intrinsic size.
   *
   * It is *only* a performance path. The obvious worry — that a fresh `Image`
   * starts at `loaded = false` and so repaints its placeholder slab — was
   * measured and does not happen: sampling the real canvas pixel at the image
   * centre in both Chromium and Firefox gives zero placeholder frames after the
   * first paint, at 60ms and at 0ms between chunks, because a cached bitmap
   * decodes before the next frame.
   *
   * The reuse is deliberately narrow: **only a growing trailing text run**. Probed
   * against `marked@18.0.7`, that is the shape a stream actually produces once an
   * image has closed — the image token's `raw` and its index are then stable while
   * trailing prose grows, and the token list settles at
   * `[…, image, text]` and stops changing length. Anything else (a new image
   * arriving, an image token changing, a run appearing before the last image)
   * falls through to the rebuild, which is correct and rare.
   *
   * Note the child list is not one entity per token: consecutive non-image tokens
   * are merged into one `RichText` by the render arm's `flushText`, so
   * `[text, text, image]` is two children, not three. The guards therefore compare
   * *token runs* split at the last image, never token index against child index.
   */
  private updateImageParagraph(
    entity: Entity,
    oldToken: Tokens.Paragraph,
    newToken: Tokens.Paragraph,
  ): boolean {
    // The `Stack` gate is what makes `children` and `resizeLastChild` meaningful:
    // an ordinary paragraph's entity is a `RichText`, which has neither the child
    // list this reasons about nor that method. Mutation-checked as caught by the
    // child-count guard below as well (a `RichText` reports zero children), but it
    // must stay: without it the resync at the end calls an undefined method.
    if (!(entity instanceof Stack)) return false;
    const oldTokens = oldToken.tokens;
    const newTokens = newToken.tokens;
    if (!oldTokens || !newTokens) return false;

    // Both sides must be the image-bearing shape this method owns. A paragraph
    // that only just gained its first image is a shape change, not a growing
    // tail, so it rebuilds.
    //
    // Mutation-checked as redundant in practice — an image-free paragraph never
    // arrives here, because the branch above claims it via `setSpans`, and if one
    // did its `RichText` entity would fail the `Stack` gate. Kept because without
    // it `-1` would make the prefix loop a no-op and slice the WHOLE token list as
    // the tail, which is a silently wrong reuse rather than a rejection.
    const oldLastImage = lastIndexOfImage(oldTokens);
    const newLastImage = lastIndexOfImage(newTokens);
    if (oldLastImage < 0 || newLastImage < 0) return false;

    // The prefix through the last image must be byte-identical. This is what
    // makes reuse safe without comparing entities: it proves every existing
    // child except a trailing text run is still correct, including each image's
    // `href` and `alt`, and that no image was inserted or removed.
    //
    // The index equality is a precondition of that loop rather than an
    // independent check — mutation-checked as redundant, because when a second
    // image arrives the raw comparison catches the same paragraph one token
    // earlier. It stays because the loop below only compares `0..newLastImage`,
    // so without it a shorter old prefix would be read past its end.
    if (oldLastImage !== newLastImage) return false;
    for (let i = 0; i <= newLastImage; i++) {
      if (oldTokens[i].raw !== newTokens[i].raw) return false;
    }

    // Only a trailing run may differ, and only by growing. A shrinking tail is
    // not something an append-only stream produces, and reusing on one would
    // leave the `Stack`'s cached height too large.
    const oldTail = oldTokens.slice(oldLastImage + 1);
    const newTail = newTokens.slice(newLastImage + 1);
    if (newTail.length === 0) return false;
    const oldTailRaw = oldTail.map((t) => t.raw).join('');
    const newTailRaw = newTail.map((t) => t.raw).join('');
    if (!newTailRaw.startsWith(oldTailRaw)) return false;

    // The entity must be the one the render arm built for the old tokens: one
    // child per image, plus one per text run. Recomputing it from the old tokens
    // rather than trusting a count keeps this correct for any arrangement of
    // runs, including two adjacent images.
    const expectedOldChildren = expectedImageParagraphChildren(oldTokens);
    if (entity.children.length !== expectedOldChildren) return false;

    const t = this.theme;
    const availableWidth = this.activeBlockMetrics?.availableWidth ?? this.maxWidth;

    if (oldTail.length === 0) {
      // The trailing run is new: the paragraph ended at its image last time, and
      // prose has now started after it. Append one run.
      entity.add(this.inlineRunRichText(newTail, availableWidth, t));
    } else {
      // The common case: the existing trailing run grew.
      //
      // The `RichText` check is defence in depth, and mutation-checked as
      // unreachable: a non-empty `oldTail` means the render arm ran `flushText`
      // after the last image, so the last child IS that run's `RichText`. An
      // `Image` can only be last when `oldTail` is empty, which is the branch
      // above. Kept because it is what makes `setSpans` provably safe here.
      const tailEntity = entity.children[entity.children.length - 1];
      if (!(tailEntity instanceof RichText)) return false;
      tailEntity.setSpans(this.inlineRunSpans(newTail, t));
    }

    // Resync the Stack from its new last child.
    //
    // Load-bearing, and only visibly so when the tail gains a LINE:
    // `RichText.setSpans` re-lays out the child but does not touch its parent's
    // cached box, so without this a wrapped tail leaves the `Stack` at its old
    // height (measured 320 where 368 is correct). A tail growing within one line
    // hides it, and `Stack.add` happens to update the height itself, which is why
    // the append branch alone would not reveal it. `resizeLastChild` falls back to
    // a full `layout()` when its invariants do not hold, so it is safe for both.
    const last = entity.children[entity.children.length - 1];
    if (last) entity.resizeLastChild(last);
    return true;
  }

  /**
   * Reuse a streamed table's `Table` entity instead of rebuilding every cell.
   *
   * Returns `false` to mean "rebuild instead", and every rejection happens before
   * any mutation, so a refused reuse leaves the entity exactly as it was.
   *
   * A `table` token carries every row, so the rebuild path costs Θ(C·N²)
   * `RichText` constructions across a stream — and a further 2×, because
   * `Table.layout()` re-runs `fitCell` on every cell. This was the last block
   * type without an in-place path.
   *
   * Two shapes have to be handled, because of how `marked` lexes a growing table
   * (probed against 18.0.7): a partial row is materialized immediately as a FULL
   * row padded with empty cells, and its cells are then filled one at a time. A
   * 2×2 table passes through eleven distinct row states, of which only two are
   * clean row appends. So handling appends alone would reject most chunks and
   * leave the quadratic cost essentially in place:
   *
   * 1. the last row's cells are rewritten in place via `setSpans`, and
   * 2. genuinely new rows go through `Table.appendRows`.
   *
   * Cells are compared by `text`, never `raw` — a table cell has no `raw` at all
   * (its keys are `text`/`tokens`/`header`/`align`).
   */
  private updateStreamedTable(
    entity: Entity,
    oldToken: Tokens.Table,
    newToken: Tokens.Table,
  ): boolean {
    if (!(entity instanceof Table)) return false;

    // The column count is fixed when the delimiter row lexes: marked pads short
    // rows and truncates long ones to `header.length`, so this can never fire in
    // practice. It is what licenses indexing every row by the header's columns.
    if (oldToken.header.length !== newToken.header.length) return false;
    // `Table` has no header mutator, so a changed header must rebuild.
    for (let c = 0; c < oldToken.header.length; c++) {
      if (oldToken.header[c].text !== newToken.header[c].text) return false;
    }
    // Alignment is fixed at construction (`Table` has no align mutator), and a
    // streamed table is first lexed the moment its delimiter row arrives — the
    // very row that carries alignment. Reusing across a change would keep the
    // stale columns silently, so rebuild.
    for (let c = 0; c < oldToken.header.length; c++) {
      if (oldToken.align?.[c] !== newToken.align?.[c]) return false;
    }

    // Append-only. Unlike a list, an EMPTY old table is not rejected: a table is
    // lexed with zero rows as soon as its delimiter row arrives, so that is the
    // first state every streamed table is in and the first reuse opportunity.
    if (newToken.rows.length < oldToken.rows.length) return false;
    // This entity must be the one the render arm built for these tokens.
    if (entity.rows.length !== oldToken.rows.length) return false;

    // Every row before the last retained one must be untouched. Probed stable, so
    // this is the cheap correctness net rather than an expected rejection.
    const lastRetained = oldToken.rows.length - 1;
    for (let r = 0; r < lastRetained; r++) {
      const oldRow = oldToken.rows[r];
      const newRow = newToken.rows[r];
      for (let c = 0; c < oldToken.header.length; c++) {
        if (oldRow[c]?.text !== newRow[c]?.text) return false;
      }
    }

    // Every cell this arm built is a RichText, but the entity could have been
    // constructed elsewhere; verify before mutating anything.
    if (lastRetained >= 0) {
      for (let c = 0; c < oldToken.header.length; c++) {
        const cell = entity.rows[lastRetained]?.[c];
        if (!(cell instanceof RichText)) return false;
      }
    }

    // ── Past every guard; mutation starts here ──────────────────────────
    const t = this.theme as Required<MarkdownTheme>;
    let changed = false;

    // 1. Rewrite the last retained row's cells whose text moved on.
    if (lastRetained >= 0) {
      const oldRow = oldToken.rows[lastRetained];
      const newRow = newToken.rows[lastRetained];
      for (let c = 0; c < oldToken.header.length; c++) {
        if (oldRow[c]?.text === newRow[c]?.text) continue;
        const cell = entity.rows[lastRetained][c] as RichText;
        cell.setSpans(this.tableCellSpans(newRow[c], t));
        changed = true;
      }
    }

    // 2. Append the rows that actually arrived.
    if (newToken.rows.length > oldToken.rows.length) {
      const added = newToken.rows
        .slice(oldToken.rows.length)
        .map((row) => row.map((cell) => this.tableCellRichText(cell, false, t)));
      // appendRows() ends in layout(), which also re-measures the cells rewritten
      // above, so no separate relayout is needed on this path.
      entity.appendRows(added);
    } else if (changed) {
      // Only cells changed, so nothing appended: re-measure them.
      entity.layout();
    }

    return true;
  }

  private updateBlockquoteTail(container: Entity, oldInner: Token[], newInner: Token[]): boolean {
    // Only the tail block may differ: every earlier inner token must be
    // byte-identical, and no block may have been added or removed. `space` tokens
    // render nothing, so compare tokens and map to children separately.
    if (oldInner.length !== newInner.length || newInner.length === 0) return false;
    const tail = newInner.length - 1;
    for (let i = 0; i < tail; i++) {
      if (oldInner[i].raw !== newInner[i].raw) return false;
    }
    const oldTail = oldInner[tail];
    const newTail = newInner[tail];
    if (oldTail.type !== newTail.type) return false;

    // container = [border, innerStack]; the render arm adds them in that order.
    const innerStack = container.children[1];
    if (!(innerStack instanceof Stack)) return false;
    const wrapper = innerStack.children.at(-1);
    if (!wrapper || wrapper.children.length !== 1) return false;
    const entity = wrapper.children[0];

    // The tail token must be the one that owns that last wrapper. A tail token
    // that renders nothing (a trailing `space`) would leave the last wrapper owned
    // by an earlier block, so updating it would write the wrong entity.
    if (!this.producesEntity(newTail)) return false;

    if (newTail.type === 'paragraph' && 'setSpans' in entity) {
      // Literal spans only. The optimistic guess is reserved for the document's
      // trailing paragraph; a paragraph nested in a quote is not it, and giving it
      // a guess would need a second unwind path keyed on the nested entity.
      (entity as Entity & { setSpans: (s: StyledSpan[]) => unknown }).setSpans(
        this.literalParagraphSpans(newTail as Tokens.Paragraph),
      );
    } else if (newTail.type === 'heading' && 'setSpans' in entity) {
      // Same depth guard as the top-level heading path: `setSpans` cannot change
      // `font`, and a heading's size comes from its depth.
      if ((oldTail as Tokens.Heading).depth !== (newTail as Tokens.Heading).depth) {
        return false;
      }
      (entity as Entity & { setSpans: (s: StyledSpan[]) => unknown }).setSpans(
        this.headingSpans(newTail as Tokens.Heading),
      );
    } else if (
      newTail.type === 'code' &&
      entity instanceof CodeBlock &&
      !rendersAsMath(newTail as Tokens.Code)
    ) {
      const codeToken = newTail as Tokens.Code;
      entity.setCode(codeToken.text, codeToken.lang ?? undefined);
    } else {
      // Any other tail type (list, table, nested blockquote) has no mutator to
      // call. A math fence whose closing fence has arrived also lands here: it
      // must become an Image, and no mutator turns a CodeBlock into one.
      return false;
    }

    // Propagate the tail's new box outward by hand: wrapper, then the stack, then
    // the border, then the container. The render arm computes all four the same
    // way, so this keeps a reused quote geometrically identical to a rebuilt one.
    wrapper.width = entity.x + entity.width;
    wrapper.height = entity.height;
    innerStack.resizeLastChild(wrapper);
    const border = container.children[0];
    if (border instanceof QuoteBorder) border.height = innerStack.height || 20;
    container.height = Math.max(border?.height ?? 0, innerStack.height);
    return true;
  }

  /**
   * Spans for a heading being updated in place.
   *
   * Kept in lockstep with the `heading` arm of {@link renderToken}, which builds
   * its `RichText` through `renderInlineToRichText`: same `collectSpans` call and
   * the same `decodeEntities` fallback when a heading has no inline tokens (`##`
   * with no text yet, which a stream produces before its first word arrives). A
   * plain `token.text` fallback here would leave an entity-bearing heading
   * undecoded on the in-place path but decoded on a fresh render.
   */
  private headingSpans(token: Tokens.Heading): StyledSpan[] {
    const spans: StyledSpan[] = [];
    if (token.tokens && token.tokens.length > 0) {
      collectSpans(token.tokens, {}, this.theme, spans, undefined, this.abbreviations);
    }
    if (spans.length === 0) spans.push({ text: decodeEntities(token.text) });
    return spans;
  }

  /**
   * Spans for the trailing paragraph with its last unclosed inline construct
   * rendered as though it had closed, or `null` when there is nothing to guess.
   *
   * `null` is the answer for every `'literal'` stream, every closed or absent
   * stream, and any trailing paragraph whose syntax is all balanced — so the
   * caller falls back to {@link literalParagraphSpans} and pays nothing.
   *
   * Only the paragraph's LAST inline token is scanned. An unclosed construct can
   * only be there: anything that closed is already its own `strong`/`em`/
   * `codespan`/`link` token, so a syntax character surviving into a trailing
   * plain-text run is one `marked` could not pair. Scanning the whole raw string
   * instead would re-find the markers of already-closed constructs.
   */
  private optimisticParagraphSpans(token: Tokens.Paragraph): StyledSpan[] | null {
    if (this.streamIncompleteMode !== 'optimistic') return null;
    if (this.streamController?.state !== 'open') return null;

    const inline = token.tokens;
    if (!inline || inline.length === 0) return null;
    // How many trailing tokens form the unstructured run, and its text. Normally
    // one plain `text` token — but `[label](https://ex` lexes as a `text` token
    // ending in `](` PLUS an autolink token for the bare URL, because marked
    // autolinks a naked URL it finds there. Left as two tokens the `[` is invisible
    // to the scan, so that pair is rejoined into one run.
    let runLength = 1;
    let runText: string;
    const last = inline[inline.length - 1];
    const prev = inline.length > 1 ? inline[inline.length - 2] : null;
    const isFlatText = (token: Token): boolean =>
      token.type === 'text' && !(token as unknown as { tokens?: Token[] }).tokens?.length;
    if (
      last.type === 'link' &&
      last.raw === (last as Tokens.Link).text &&
      prev !== null &&
      isFlatText(prev) &&
      (prev as Tokens.Text).text.endsWith('](')
    ) {
      runLength = 2;
      runText = (prev as Tokens.Text).text + last.raw;
    } else if (isFlatText(last)) {
      runText = (last as Tokens.Text).text;
    } else {
      // A nested-token text run has structure inside it, so it is not the flat
      // trailing run this scan is defined over.
      return null;
    }

    const found = findUnclosedInline(runText);
    if (!found) return null;

    // Everything before the trailing run keeps exactly the styling `marked` gave
    // it — those tokens are not what changed between chunks.
    const spans: StyledSpan[] = [];
    if (inline.length > runLength) {
      collectSpans(
        inline.slice(0, -runLength),
        {},
        this.theme,
        spans,
        undefined,
        this.abbreviations,
      );
    }
    const head = runText.slice(0, found.at);
    if (head) spans.push({ text: decodeEntities(head) });

    let content = runText.slice(found.contentAt);
    if (found.kind === 'link') {
      // `[label](htt` — show the label only. With no closing paren there is no
      // URL yet, so there is nothing safe to make clickable, and printing the
      // half-typed destination is noise.
      const close = content.indexOf('](');
      if (close !== -1) content = content.slice(0, close);
    }
    if (!content) return null;

    const style = this.optimisticStyle(found.kind);
    spans.push({ text: decodeEntities(content), style });
    return spans;
  }

  /** Display style for a guessed-closed construct. */
  private optimisticStyle(kind: UnclosedInline['kind']): TextStyle | undefined {
    switch (kind) {
      case 'strong':
        return { bold: true };
      case 'em':
        return { italic: true };
      case 'codespan':
        return { color: this.theme.codeColor, fontFamily: this.theme.codeFont };
      // A link with no closing paren has no href, so it renders as plain text —
      // no link color and no click affordance for a destination nobody has yet.
      case 'link':
        return undefined;
    }
  }

  /**
   * Re-render the paragraph currently showing a guess from its own tokens, with
   * no overlay, and forget it.
   *
   * Idempotent and free when no guess is live, which is what lets `close()`,
   * `abort()`, and a mid-stream staleness check all call it unconditionally.
   */
  /**
   * Start the MathJax load, and re-typeset this document once it resolves.
   *
   * Called from two places, for two different reasons:
   *
   * - When an OPEN math fence is rendered. This is a prefetch, and it is what
   *   makes the lazy load invisible while streaming: the module starts loading
   *   the moment a formula begins arriving, several chunks before its closing
   *   fence, so by the time the fence closes the converter is usually already
   *   installed and the formula typesets synchronously on the normal path.
   * - When a CLOSED fence could not be typeset because the module is not ready.
   *   That is the case a rebuild actually exists for: a document constructed with
   *   math already complete, or a stream that closed a fence faster than the
   *   module loaded.
   *
   * Idempotent per instance. Concurrent callers coalesce onto the one cached
   * module promise, and `mathLoadPending` keeps a second rebuild from being
   * queued while the first is outstanding.
   */
  private ensureMathJax(): void {
    if (isMathJaxReady() || this.mathLoadPending || this.isDestroyed) return;
    this.mathLoadPending = true;
    void preloadMathJax().then(() => {
      this.mathLoadPending = false;
      // Destroyed while the module was in flight: the tree this would rebuild
      // is gone, and re-rendering into it would resurrect a detached subtree.
      if (this.isDestroyed) return;
      // A failed load leaves the converter null. Every formula stays TeX source,
      // which is exactly what is on screen already, so a rebuild would be pure
      // cost for an identical tree.
      if (isMathJaxReady()) this.retypesetFromTokens();
      // Settlement was held open for this; release it either way.
      this.flushAppendSettledWaiters();
    });
  }

  /**
   * Rebuild every block from the tokens already lexed, without re-lexing.
   *
   * Used only when MathJax arrives after a formula has already been rendered as
   * source. Rebuilding wholesale rather than surgically replacing the math blocks
   * is the deliberate choice: `tokenChildPrefix` maps token indices to child
   * slots positionally, so swapping one child in place would have to keep that
   * mapping, the `Stack`'s cached box, and every following sibling's position in
   * agreement by hand. Re-rendering the same token list in the same order leaves
   * the mapping trivially correct, and this runs at most once per document — the
   * same cost as the `setContent` rebuild that already exists.
   *
   * The optimistic tail is dropped first. Its `entity` is about to be destroyed,
   * so the pointer would dangle; unwinding restores literal spans, and if the
   * stream is still open the next chunk re-applies a guess.
   */
  private retypesetFromTokens(): void {
    this.unwindOptimisticTail();
    const tokens = this.tokens;
    while (this.content.children.length > 0) {
      this.content.children[this.content.children.length - 1].destroy();
    }
    for (const token of tokens) {
      const el = this.renderToken(token);
      if (el) this.content.add(el);
    }
    this.width = this.content.width;
    this.height = this.content.height;
    this.scene?.markDirty();
  }

  private unwindOptimisticTail(): void {
    const tail = this.optimisticTail;
    this.optimisticTail = null;
    if (!tail || this.isDestroyed) return;
    const entity = tail.entity as Entity & {
      setSpans?: (spans: StyledSpan[]) => unknown;
    };
    // Gone from the tree (destroyed by a later reconcile, or replaced wholesale
    // by setContent) — nothing to unwind, and re-rendering it would resurrect
    // spans on a detached entity.
    if (!entity.setSpans || entity.parent !== this.content) return;
    entity.setSpans(this.literalParagraphSpans(tail.token));
    // Height changed, so the container's cached box has to follow. The O(1)
    // resync is only valid while this really is the last child; once a later
    // block exists, every sibling below it moves and a full reflow is required.
    if (this.content.children.at(-1) === entity) {
      this.content.resizeLastChild(entity);
    } else {
      this.content.layout();
    }
    this.width = this.content.width;
    this.height = this.content.height;
    this.scene?.markDirty();
  }

  /**
   * Drop a guess that is no longer on the document's trailing paragraph.
   *
   * A coalesced append can add a block after the paragraph that owns the guess,
   * at which point the guess is frozen — the construct can never close, because
   * no further text lands in that paragraph. Without this the stale styling would
   * survive until `close()`.
   *
   * `writtenThisPass` is the entity whose spans this reconcile already rewrote,
   * if any: for that one, literal spans are on screen already and re-rendering it
   * would be wasted layout, so only the bookkeeping is cleared.
   */
  private dropStaleOptimisticTail(trailing: Entity | null, writtenThisPass: Entity | null): void {
    const tail = this.optimisticTail;
    if (!tail || tail.entity === trailing) return;
    if (tail.entity === writtenThisPass) {
      this.optimisticTail = null;
      return;
    }
    this.unwindOptimisticTail();
  }

  /**
   * Resolve once every in-flight worker append has actually been applied.
   *
   * Committing text is not the same as the document reflecting it: `append()`
   * reaches `dispatchAppend()`, which `postMessage()`s and returns, and the reply
   * that runs `updateTokens()` lands later. Without waiting here, `close()` could
   * resolve — and `onStable` fire — against a document missing its last chunk.
   *
   * An outstanding lazy MathJax load counts as unsettled for the same reason. A
   * document whose formulas are still TeX source is not final in any sense a
   * caller of `onStable` cares about: the boxes are the wrong size, so measuring
   * or exporting there would capture placeholders.
   */
  private waitForAppendSettled(): Promise<void> {
    if (!this.appendInFlight && !this.mathLoadPending) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.appendSettledWaiters.push(resolve);
    });
  }

  /**
   * Release settlement waiters, but only once nothing is outstanding.
   *
   * Called at the very END of the worker callback, after its coalesced-re-dispatch
   * check, rather than wherever `appendInFlight` goes false. Within that callback
   * `appendInFlight` is cleared and then, if another chunk arrived while the
   * request was in flight, set straight back to `true` by the re-dispatch — both
   * synchronously, before anything watching the flag could observe the gap. Only
   * checking here, after that, waits through the re-dispatch instead of resolving
   * one chunk early.
   */
  private flushAppendSettledWaiters(): void {
    if (this.appendInFlight || this.mathLoadPending || this.appendSettledWaiters.length === 0) {
      return;
    }
    const waiters = this.appendSettledWaiters;
    this.appendSettledWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /** Throw if a public mutation is attempted from inside an `onStable` callback. */
  private assertNotInStableCallback(method: string): void {
    if (this.inStableCallback) {
      throw new Error(`Markdown.${method}() cannot be called from an onStable callback`);
    }
  }

  private updateTokens(newTokens: TokensList, knownMatchLen?: number): void {
    const oldTokens = this.tokens;
    const oldChildren = [...this.content.children]; // snapshot

    // The raw-equal prefix length. The worker already computed this to decide
    // what tail to send, so when it hands the value over there is nothing to
    // re-derive — this loop was re-scanning every token's `raw` string on the
    // main thread for a result the worker had already produced.
    //
    // Validated rather than trusted blindly: `knownMatchLen` is relative to the
    // token snapshot the request was issued against, and a bug (or a future
    // protocol change) that let it exceed either array would silently reuse the
    // wrong entities. Out-of-range falls through to the scan.
    let matchLen: number;
    const minLen = Math.min(oldTokens.length, newTokens.length);
    if (knownMatchLen !== undefined && knownMatchLen >= 0 && knownMatchLen <= minLen) {
      matchLen = knownMatchLen;
    } else {
      matchLen = 0;
      for (let i = 0; i < minLen; i++) {
        if (oldTokens[i].raw === newTokens[i].raw) {
          matchLen++;
        } else {
          break;
        }
      }
    }

    // A changed abbreviation dictionary invalidates the ENTIRE raw-equal prefix,
    // not just the tokens that changed. `*[HTML]: …` arriving now can affect a
    // `HTML` occurrence in a paragraph whose own `raw` is untouched — exactly
    // `markdown-abbr.ts`'s documented parallel to `hasLinkDefinitions`'s late
    // reference-definition problem. Capping `matchLen` to 0 here forces every
    // entity below to go through the rebuild path (nothing before it can be
    // reused), which is the only way a definition arriving anywhere in the
    // document can retroactively re-style prose that already rendered.
    const newAbbreviations = collectAbbreviations(newTokens);
    const abbreviationsChanged = !mapsEqual(this.abbreviations, newAbbreviations);
    if (abbreviationsChanged) matchLen = 0;
    this.abbreviations = newAbbreviations;

    // Old-token-index → child-entity index (tokens that render nothing don't
    // consume a child slot — see producesEntity). This prefix sum is maintained
    // incrementally by setTokens(), so it's already valid for `oldTokens` here:
    // reading it is O(1) instead of the O(total blocks) rebuild this used to do
    // on every streamed chunk.
    const oldTokenToChild = this.tokenChildPrefix;
    // The raw-equal prefix length, captured before the in-place paragraph branch
    // below mutates `matchLen`. Everything before it is unchanged, so the child
    // prefix sum stays valid there and only the suffix is recomputed.
    const rawMatchLen = matchLen;
    // The guess this pass produced, and the entity whose spans it already wrote.
    // Both are settled by one post-pass below rather than by each render site, so
    // there is a single place that decides which entity may carry a guess.
    let pendingTail: { entity: Entity; token: Tokens.Paragraph } | null = null;
    let spansWrittenTo: Entity | null = null;

    // Handle the common streaming case: the last token changed but kept its type,
    // so its entity can be updated in place instead of destroyed and rebuilt.
    //
    // `code` is here alongside `paragraph` because an unclosed fenced block is the
    // second most common shape an LLM streams, and it is the worst case for the
    // rebuild path: CodeBlock re-tokenizes and re-measures its whole grid on
    // construction, so a block growing one line at a time paid that for every
    // chunk. `setCode()` already existed for live editing; the reconciler simply
    // never called it.
    //
    // `heading` is the third, and was the cheapest to add: it already renders to a
    // `RichText` through the very same `renderInlineToRichText` a paragraph uses,
    // so the mutator was there and only the dispatch below was missing. It carries
    // an extra depth guard the other two do not need — see that branch.
    //
    // Still rebuilt every chunk: `blockquote` (a container of recursively rendered
    // children, so it needs tail-child descent), and `list`/`table` (no mutator
    // exists to call — `Table` exposes only `setSelectable`, so reuse there means
    // new public @vectojs/ui API plus key-based row identity, since the ordinal
    // marker is position-derived).
    const lastTokenSameType =
      matchLen === oldTokens.length - 1 &&
      matchLen < newTokens.length &&
      oldTokens[matchLen]?.type === newTokens[matchLen]?.type;

    if (lastTokenSameType && newTokens[matchLen]?.type === 'code') {
      const existingEntity = oldChildren[oldTokenToChild[matchLen]];
      const codeToken = newTokens[matchLen] as Tokens.Code;
      const oldCodeToken = oldTokens[matchLen] as Tokens.Code;
      const isMath = rendersAsMath(codeToken);
      if (isMath && rendersAsMath(oldCodeToken) && oldCodeToken.text === codeToken.text) {
        // Both sides are the same typeset formula, so the rendered entity is
        // already correct and there is nothing to mutate. This is the common
        // shape right after a fence closes: the next chunk appends the newline
        // that follows it, which changes `raw` (so the prefix match stops short)
        // without changing the formula. Reusing here skips a rebuild and, more
        // to the point, an SVG re-decode.
        this.streamStats.inPlaceUpdates++;
        matchLen++;
      } else if (existingEntity instanceof CodeBlock && !isMath) {
        // Language can change mid-stream: ```` ``` ```` then the info string
        // arrives on the next chunk, so pass it through rather than assuming it
        // is stable.
        //
        // `!isMath` is what lets a closing fence land: while the fence is open a
        // math block IS a CodeBlock, and the chunk that closes it must fall
        // through to the rebuild path to become a formula. Without the guard
        // `setCode` would keep the CodeBlock and the formula would never typeset.
        existingEntity.setCode(codeToken.text, codeToken.lang ?? undefined);
        this.streamStats.inPlaceUpdates++;
        matchLen++;
        // Same O(1) tail resync as the paragraph path: the block is still the
        // Stack's last child, so its own box changed but no sibling moved.
        this.content.resizeLastChild(existingEntity);
      }
    } else if (lastTokenSameType && newTokens[matchLen]?.type === 'paragraph') {
      // Update existing paragraph entity in-place via setSpans
      const entityIdx = oldTokenToChild[matchLen];
      const existingEntity = oldChildren[entityIdx];
      // The `setSpans` path is only valid while the paragraph still renders as one
      // `RichText`. It dispatches on the ENTITY's shape, so without the token check
      // a plain paragraph that gains its first image kept its `RichText` and was
      // handed the image paragraph's spans — and `collectSpans` emits nothing for
      // an `image` token, so the picture was silently DROPPED. Streamed
      // `'Figure: '` then `'![a](u.png)'` rendered a bare `RichText` where a
      // one-shot build gives `Stack[RichText, Image]`. Pre-existing: reproduced
      // unchanged on the commit before this one.
      if (
        existingEntity &&
        'setSpans' in existingEntity &&
        !paragraphHasImage(newTokens[matchLen] as Tokens.Paragraph)
      ) {
        // Re-render the paragraph's inline tokens
        const pToken = newTokens[matchLen] as Tokens.Paragraph;
        // `lastTokenSameType` is indexed off the OLD token list, so it does not
        // imply this is the document's last block: one coalesced append can close
        // this paragraph and start a new block in the same update. Only the real
        // trailing paragraph may carry an optimistic guess.
        const isTrailing = matchLen === newTokens.length - 1;
        const optimistic = isTrailing ? this.optimisticParagraphSpans(pToken) : null;
        // One setSpans either way: computing the guess instead of the literal
        // spans, rather than writing literal spans and then overwriting them,
        // keeps the streaming hot path at a single layout per chunk.
        (existingEntity as any).setSpans(optimistic ?? this.literalParagraphSpans(pToken));
        spansWrittenTo = existingEntity;
        if (optimistic) pendingTail = { entity: existingEntity, token: pToken };
        this.streamStats.inPlaceUpdates++;
        matchLen++; // This token is now handled
        // Streaming's hot path: the growing paragraph is still the Stack's
        // last child, so its own size changed but no sibling moved — resync
        // the container's cached width/height in O(1) instead of falling
        // through to the unconditional full `layout()` this used to run on
        // every single streamed chunk regardless of what actually changed.
        this.content.resizeLastChild(existingEntity);
      } else if (
        existingEntity &&
        this.updateImageParagraph(
          existingEntity,
          oldTokens[matchLen] as Tokens.Paragraph,
          newTokens[matchLen] as Tokens.Paragraph,
        )
      ) {
        // A paragraph containing an image renders as a `Stack`, which has no
        // `setSpans`, so it fell out of the branch above and was rebuilt on every
        // chunk. This `else` is the fix; until it existed the miss was invisible,
        // because the `if` had no alternative and simply dropped through to the
        // destroy/render loops with `inPlaceUpdates` never incrementing.
        this.streamStats.inPlaceUpdates++;
        matchLen++;
        this.content.resizeLastChild(existingEntity);
      }
    } else if (lastTokenSameType && newTokens[matchLen]?.type === 'heading') {
      // A heading renders through the same `renderInlineToRichText` as a
      // paragraph, so the entity it produced already has `setSpans` — the
      // reconciler simply never dispatched to it, and a heading streamed a word
      // at a time rebuilt its RichText and re-shaped its text on every chunk.
      const existingEntity = oldChildren[oldTokenToChild[matchLen]];
      const hToken = newTokens[matchLen] as Tokens.Heading;
      const oldToken = oldTokens[matchLen] as Tokens.Heading;
      // Depth must be unchanged to reuse. `RichText.setSpans` replaces the runs
      // and re-lays out but does NOT touch `font`, which is constructor-only, and
      // a heading's font size is derived from its depth. Streaming `#` and then
      // `# T` lexes to `## T`: the same token index goes from depth 1 to depth 2
      // while still being a `heading`, so reusing blindly would paint an h2 at
      // h1's size. Fall through to the rebuild in that case.
      if (existingEntity && 'setSpans' in existingEntity && oldToken?.depth === hToken.depth) {
        (existingEntity as any).setSpans(this.headingSpans(hToken));
        // No optimistic guess for headings. `optimisticParagraphSpans` reads
        // `incompleteMode` for the trailing *paragraph*; a heading is a single
        // short line whose unclosed emphasis closes within a chunk or two, so the
        // guess would buy a frame of styling at the cost of another code path
        // that has to be unwound on close(). Literal spans only.
        spansWrittenTo = existingEntity;
        this.streamStats.inPlaceUpdates++;
        matchLen++;
        // Same O(1) tail resync as the paragraph and code paths.
        this.content.resizeLastChild(existingEntity);
      }
    } else if (lastTokenSameType && newTokens[matchLen]?.type === 'blockquote') {
      // A blockquote is the one reusable block that owns a subtree rather than a
      // single entity, so reuse means descending to its tail child instead of
      // calling a mutator on the block itself. A quote streamed line by line
      // otherwise rebuilt every inner block plus the border on every chunk.
      const existingEntity = oldChildren[oldTokenToChild[matchLen]];
      const newInner = (newTokens[matchLen] as Tokens.Blockquote).tokens;
      const oldInner = (oldTokens[matchLen] as Tokens.Blockquote).tokens;
      if (
        existingEntity instanceof MarkdownContainer &&
        newInner &&
        oldInner &&
        this.updateBlockquoteTail(existingEntity, oldInner, newInner)
      ) {
        this.streamStats.inPlaceUpdates++;
        matchLen++;
        this.content.resizeLastChild(existingEntity);
      }
    } else if (lastTokenSameType && newTokens[matchLen]?.type === 'list') {
      // A list is the worst rebuild case in this reconciler, because the token
      // keeps EVERY item: a list streamed to N items rebuilt 1+2+…+N RichTexts,
      // i.e. Theta(N^2). Measured before this path existed, a 32-item list cost
      // 528 constructions against 32 for the same list built once.
      const existingEntity = oldChildren[oldTokenToChild[matchLen]];
      if (
        existingEntity &&
        this.updateStreamedList(
          existingEntity,
          oldTokens[matchLen] as Tokens.List,
          newTokens[matchLen] as Tokens.List,
        )
      ) {
        this.streamStats.inPlaceUpdates++;
        matchLen++;
        this.content.resizeLastChild(existingEntity);
      }
    } else if (lastTokenSameType && newTokens[matchLen]?.type === 'table') {
      // The last block type to get an in-place path, and the most expensive one
      // to rebuild: a table token carries every row, so the rebuild cost is
      // Theta(C*N^2) cell constructions across a stream, plus a further 2x
      // because Table.layout() re-runs fitCell on every cell.
      const existingEntity = oldChildren[oldTokenToChild[matchLen]];
      if (
        existingEntity &&
        this.updateStreamedTable(
          existingEntity,
          oldTokens[matchLen] as Tokens.Table,
          newTokens[matchLen] as Tokens.Table,
        )
      ) {
        this.streamStats.inPlaceUpdates++;
        matchLen++;
        this.content.resizeLastChild(existingEntity);
      }
    }

    // Destroy excess old entities (from matchLen onward). destroy() (not just
    // remove()) so a discarded block's subtree resources are released, and it
    // detaches from `content` itself. Starts AT matchLen — the old loop walked
    // every token from 0 only to skip the matched prefix with an `i >= matchLen`
    // test, making it O(total blocks) per streamed chunk.
    // Everything before matchLen kept its entity untouched, which is the reuse
    // the incremental path exists to produce.
    for (let i = 0; i < matchLen; i++) {
      if (this.producesEntity(oldTokens[i])) this.streamStats.entitiesReused++;
    }
    for (let i = matchLen; i < oldTokens.length; i++) {
      if (this.producesEntity(oldTokens[i])) {
        this.streamStats.entitiesRebuilt++;
        const idx = oldTokenToChild[i];
        if (idx < oldChildren.length) {
          oldChildren[idx].destroy();
        }
      }
    }

    // Add new entities for tokens beyond matchLen
    const lastIndex = newTokens.length - 1;
    for (let i = matchLen; i < newTokens.length; i++) {
      const el = this.renderToken(newTokens[i]);
      if (!el) continue;
      this.content.add(el);
      // A fresh trailing paragraph — the first one of a stream, or one following
      // a block that just closed — gets the same guess the in-place branch above
      // applies. `renderToken` is the documented subclass override seam, so the
      // overlay is applied over its result here instead of by threading a mode
      // parameter through that signature.
      if (i === lastIndex && newTokens[i].type === 'paragraph' && 'setSpans' in el) {
        const pToken = newTokens[i] as Tokens.Paragraph;
        const optimistic = this.optimisticParagraphSpans(pToken);
        if (optimistic) {
          (el as any).setSpans(optimistic);
          this.content.resizeLastChild(el);
          pendingTail = { entity: el, token: pToken };
          spansWrittenTo = el;
        }
      }
    }

    // One place decides which entity may carry a guess. A coalesced append can
    // add a block after the paragraph that owned the previous guess, and that
    // guess is then frozen — no further text can land in that paragraph, so the
    // construct can never close and the styling would otherwise survive to
    // close(). `spansWrittenTo` is excluded from the re-render because literal
    // spans are already on screen for it.
    this.dropStaleOptimisticTail(pendingTail?.entity ?? null, spansWrittenTo);
    if (pendingTail) this.optimisticTail = pendingTail;

    // The raw-equal prefix is unchanged, so its child-index entries stay valid;
    // only the suffix prefix-sum is recomputed.
    this.setTokens(newTokens, rawMatchLen);
    // No explicit layout() here: the common in-place resize above uses
    // resizeLastChild(), and any add()/remove() calls in the loops above
    // already keep `content`'s own width/height correct as they happen (see
    // Stack.add()'s fastAppendDirty resync) — an unconditional full layout()
    // on every call would silently redo (or, for the pure-resize case,
    // needlessly perform for the first time) an O(children) walk on every
    // single streamed chunk.
    this.width = this.content.width;
    this.height = this.content.height;

    this.scene?.markDirty();
    if (this.onLayoutUpdated) {
      this.onLayoutUpdated();
    }
  }

  /**
   * Render one nested block with a temporary width/margin context while
   * preserving `renderToken` as the subclass override seam.
   */
  private renderTokenWithMetrics(token: Token, metrics: BlockMetrics): Entity | null {
    const previous = this.activeBlockMetrics;
    this.activeBlockMetrics = metrics;
    try {
      return this.renderToken(token);
    } finally {
      this.activeBlockMetrics = previous;
    }
  }

  /**
   * Whether {@link renderToken} produces a child entity for this token (vs
   * `null`). `updateTokens` maps token indices to child-entity indices, and the
   * reconcile/removal loops must skip EXACTLY the tokens that render nothing —
   * not just `space`. A `space`, a non-SVG raw `html` block (an HTML comment,
   * a bare `<div>`), or a fallback token without `text` all render null; before
   * this, only `space` was skipped, so a null-rendering `html`/`def` token
   * before the growing tail shifted every subsequent entity index by one and
   * the wrong entity was updated or destroyed. Kept in lockstep with
   * `renderToken`'s null returns.
   */

  protected producesEntity(token: Token): boolean {
    switch (token.type) {
      case 'space':
        return false;
      case 'html': {
        const text = (token as Tokens.HTML).text.toLowerCase();
        return text.includes('<svg') && text.includes('</svg>');
      }
      case 'heading':
      case 'paragraph':
      case 'code':
      case 'blockquote':
      case 'list':
      case 'table':
      case 'hr':
      // A footnote definition is the only block-level token this package adds, so
      // it is the only one for which this three-way lockstep (here,
      // `renderToken`, `reflowToken`) has to be established rather than inherited.
      // It renders its own block, so it produces an entity — see `renderToken`'s
      // arm for why in place rather than collected into a document footer.
      case 'footnoteDef':
      // A `ContainerToken` carries `tokens`, not `text`, so it would otherwise
      // fail the `default:` arm's `'text' in token` fallback check entirely —
      // the same trap `footnoteDef` above already documents.
      case 'container':
        return true;
      default:
        return 'text' in token;
    }
  }

  /**
   * Build a centered display-math block, or `null` if MathJax cannot typeset yet.
   *
   * Shared by the `$$..$$` block token and a closed ```` ```math ```` fence:
   * both are display math and must render identically, differing only in how
   * they were spelled in the source.
   *
   * `ex` is font-relative, so the intrinsic box is resolved against the theme's
   * body size. This is what a previously hardcoded `* 8` got wrong -- exact only
   * near fontSize 18.1px, so a formula was ~13% oversized at the 16px default
   * and far worse at other sizes.
   */
  private renderDisplayMath(formula: string, availableWidth: number): Entity | null {
    const t = this.theme;
    const mathData = renderMathToSVGDataURI(formula, true, t.textColor);
    if (!mathData) return null;
    const intrinsicW = exToPx(mathData.widthEx, t.fontSize);
    const intrinsicH = exToPx(mathData.heightEx, t.fontSize);
    // Downscale to fit, never up: a short formula keeps its typeset size rather
    // than being stretched across the column.
    const scale = Math.min(1, availableWidth / intrinsicW);
    const width = intrinsicW * scale;
    const height = intrinsicH * scale;
    // Bound outside the span so the closure captures the URI rather than the whole
    // `MathRender`, matching the inline arm.
    const uri = mathData.uri;
    // One inline object in a one-span RichText, which is the same seam inline math
    // uses. That is what makes the formula reachable by find-in-page, selection and
    // copy: `RichText` substitutes an object's `alt` for the U+FFFC sentinel when it
    // projects (see its `accessibleText`/`projectedSlice`). The previous `Image`
    // reported `tag: 'img'` with no content projection, so the formula existed only
    // as an accessible name and contributed nothing to the text layer -- the
    // asymmetry a reader hit when inline `$..$` in the same document selected fine.
    //
    // Emitting an `Image` is also what made a formula draggable as an SVG *file*,
    // since an `<img src="data:...">` is a drag source by default. No reference
    // implementation needs a `draggable="false"` workaround, because none generates
    // an image; this removes the vector rather than suppressing it.
    const math = new RichText(
      [
        {
          text: OBJECT_REPLACEMENT,
          object: {
            width,
            height,
            // The TeX source is what a reader copies and what a screen reader
            // announces. KaTeX's dual-layer contract carries the same string in an
            // `<annotation encoding="application/x-tex">`; here the projection is
            // the semantic layer, so one copy of the source serves both.
            alt: formula,
            paint: (surface, box) => paintInlineMath(uri, surface, box),
          },
        },
      ],
      {
        font: `${t.fontSize}px ${t.bodyFont}`,
        color: t.textColor,
        maxWidth: availableWidth,
        selectable: this.selectable,
      },
    );
    // The raster decodes asynchronously and the painter cannot ask for its own
    // repaint, so an `onDemand` scene would leave the box blank forever. This is the
    // shared subscription the inline arm relies on for the same reason.
    this.subscribeInlineMathRepaint();
    // Let the layout flow it as a block.
    const wrapper = new MathBlock(formula, uri);
    math.x = 16;
    math.y = 8;
    wrapper.add(math);
    wrapper.width = width + 16;
    wrapper.height = height + 16;
    return wrapper;
  }

  protected renderToken(token: Token): Entity | null {
    const t = this.theme;
    const bodyFont = `${t.fontSize}px ${t.bodyFont}`;
    const metrics = this.activeBlockMetrics ?? {
      marginBefore: 0,
      marginAfter: 0,
      indentStart: 0,
      availableWidth: this.maxWidth,
    };
    const availableWidth = metrics.availableWidth;

    // Inline `$...$` needs MathJax just as a fence does, and only the `code` arm
    // below used to ask for it — so a document whose only math was inline never
    // started the load and its formulas stayed TeX source forever. Checked here
    // rather than per-arm because inline math can appear in a heading, list item,
    // blockquote, or table cell, not just a paragraph.
    if (containsInlineMath(token)) {
      if (!isMathJaxReady()) this.ensureMathJax();
      // A typeset formula paints from a raster that decodes asynchronously, and
      // the paint callback has no way to ask for a repaint itself. Subscribed here
      // rather than at span-collection time because that is a free function with
      // no access to this instance.
      this.subscribeInlineMathRepaint();
    }

    // An image that shares a line with text (heading, table cell) renders as an
    // inline object whose box is fixed when its span is collected, before the
    // raster has decoded and therefore before its aspect ratio is known. The
    // decode is what supplies it, so unlike math this needs a re-measure and not
    // only a repaint. Subscribed for any image-bearing token: a paragraph image
    // does not need it (its `Image` entity resizes itself in `onLoad`), but
    // distinguishing the contexts here would duplicate the paragraph-splitting
    // decision, and a redundant subscription costs one no-op rebuild check.
    if (containsImage([token])) this.subscribeInlineImageRemeasure();

    switch (token.type) {
      // ── Headings ─────────────────────────────────────────────────────
      case 'heading': {
        const hToken = token as Tokens.Heading;
        const size = headingSize(t, hToken.depth);
        const headingFont = `bold ${size}px ${t.bodyFont}`;
        return renderInlineToRichText(
          hToken.tokens,
          hToken.text,
          headingFont,
          t.headingColor,
          availableWidth,
          t,
          this.selectable,
          this.onLinkClick,
          this.abbreviations,
        );
      }

      // ── Paragraphs ───────────────────────────────────────────────────
      case 'paragraph': {
        const pToken = token as Tokens.Paragraph;
        if (!paragraphHasImage(pToken)) {
          return renderInlineToRichText(
            pToken.tokens,
            pToken.text,
            bodyFont,
            t.textColor,
            availableWidth,
            t,
            this.selectable,
            this.onLinkClick,
            this.abbreviations,
          );
        }

        // Split paragraph into a Stack if it contains images
        const stack = new Stack({
          direction: 'vertical',
          gap: this.theme.blockGap,
          maxWidth: availableWidth,
        });
        let currentTokens: Token[] = [];

        const flushText = () => {
          if (currentTokens.length > 0) {
            stack.add(this.inlineRunRichText(currentTokens, availableWidth, t));
            currentTokens = [];
          }
        };

        // Flattened first: an image inside a link or an emphasis is not a direct
        // member of this array, and the split below can only see direct members.
        for (const child of liftNestedImages(pToken.tokens)) {
          if (child.type === 'image') {
            flushText();
            stack.add(this.paragraphImage(child as Tokens.Image, availableWidth));
          } else {
            currentTokens.push(child);
          }
        }
        flushText();
        return stack;
      }

      // ── Display math (`$$..$$`) ──────────────────────────────────────
      case 'blockMath': {
        const mathToken = token as Tokens.Generic & { text: string };
        const mathBlock = this.renderDisplayMath(mathToken.text, availableWidth);
        if (mathBlock) return mathBlock;
        // MathJax has not loaded yet. `ensureMathJax` retypesets from tokens
        // once it lands, so showing the TeX source is transient rather than
        // final -- and it is the honest thing to show meanwhile.
        this.ensureMathJax();
        return new CodeBlock(mathToken.text, 'latex', availableWidth, t, this.selectable);
      }

      // ── Code blocks ──────────────────────────────────────────────────
      case 'code': {
        const codeToken = token as Tokens.Code;
        const lang = (codeToken.lang ?? '').toLowerCase();

        // A math fence is typeset only once its closing fence arrives. While it
        // is still open it renders as an ordinary CodeBlock showing the TeX
        // source, which is both the honest thing to show (the formula genuinely
        // is not finished) and the cheap one: MathJax is the most expensive call
        // in this package, and converting every prefix of a streamed formula
        // spends all of it on syntactically invalid TeX that renders as an error
        // glyph nobody wants to see. As a CodeBlock it also gets the existing
        // `setCode` in-place update, so the growing source costs one mutator
        // call per chunk instead of a rebuild.
        // Begin loading MathJax as soon as a math fence appears, even while it is
        // still open. During a stream that prefetch is what hides the lazy load
        // entirely: the module is fetched over the several chunks it takes the
        // formula to arrive, so the closing fence typesets on the synchronous
        // path below.
        if (MATH_LANGS.has(lang)) this.ensureMathJax();

        if (rendersAsMath(codeToken)) {
          const mathBlock = this.renderDisplayMath(codeToken.text, availableWidth);
          if (mathBlock) return mathBlock;
        }

        return this.withBlockAffordances(
          new CodeBlock(codeToken.text, lang, availableWidth, t, this.selectable),
          () => this.codeBlockAffordances(codeToken.text, lang),
        );
      }

      // ── Blockquotes ──────────────────────────────────────────────────
      case 'blockquote': {
        const bqToken = token as Tokens.Blockquote;
        const innerStack = new Stack({
          direction: 'vertical',
          gap: this.theme.quoteInnerGap,
        });
        const indentStart = Math.min(this.theme.quoteIndent, availableWidth);
        const childMetrics: BlockMetrics = {
          marginBefore: 0,
          marginAfter: 0,
          indentStart,
          availableWidth: Math.max(0, availableWidth - indentStart),
        };

        // Recursively render inner tokens.
        //
        // `quoteTextColor` is applied by swapping `this.theme` for the duration
        // of the recursion rather than by threading a colour argument through
        // `renderTokenWithMetrics`. Every render path already reads
        // `this.theme` at its entry, so the swap reaches arbitrarily deep
        // children (a table inside a quote inside a list) with no signature
        // change. Restored in `finally` so a throw cannot leak the quote colour
        // into the rest of the document.
        const outerTheme = this.theme;
        if (t.quoteTextColor !== t.textColor) {
          this.theme = { ...outerTheme, textColor: t.quoteTextColor };
        }
        try {
          if (bqToken.tokens) {
            for (const inner of bqToken.tokens) {
              const el = this.renderTokenWithMetrics(inner, childMetrics);
              if (el) {
                const wrapper = new MarkdownContainer();
                el.x = childMetrics.indentStart;
                wrapper.add(el);
                wrapper.width = el.width + childMetrics.indentStart;
                wrapper.height = el.height;
                innerStack.add(wrapper);
              }
            }
          }
        } finally {
          this.theme = outerTheme;
        }

        // Add the vertical accent bar
        const border = new QuoteBorder(
          innerStack.height || 20,
          t.quoteBorderColor,
          t.quoteBorderWidth,
        );

        // A plain Entity, not a Stack: the border and text overlay at the same
        // position (both at x=0, y=0), they aren't laid out sequentially. A
        // Stack re-runs its own sequential layout on every add() (see
        // Stack.add), which would silently move the second child below the
        // first regardless of any position set on it beforehand.
        const container = new MarkdownContainer();
        border.x = 0;
        border.y = 0;
        container.add(border);

        // Overlay the inner text stack
        innerStack.y = 0;
        innerStack.x = 0;
        container.add(innerStack);
        container.width = availableWidth;
        container.height = Math.max(border.height, innerStack.height);

        return container;
      }

      // ── `:::` fenced containers ─────────────────────────────────────
      case 'container': {
        // Shape mirrors `blockquote`'s exactly — MarkdownContainer[
        // ContainerBackground, QuoteBorder, Stack[MarkdownContainer[block], …]]
        // — one layer deeper only for the background fill a blockquote does
        // not have. `reflowToken`'s `container` arm below assumes this exact
        // child order.
        const ctToken = token as ContainerToken;
        const accent = containerColor(t, ctToken.kind);
        const innerStack = new Stack({
          direction: 'vertical',
          gap: t.containerInnerGap,
        });
        const indentStart = Math.min(t.containerIndent, availableWidth);
        const childMetrics: BlockMetrics = {
          marginBefore: 0,
          marginAfter: 0,
          indentStart,
          availableWidth: Math.max(0, availableWidth - indentStart),
        };
        for (const inner of ctToken.tokens) {
          const el = this.renderTokenWithMetrics(inner, childMetrics);
          if (el) {
            const wrapper = new MarkdownContainer();
            el.x = childMetrics.indentStart;
            wrapper.add(el);
            wrapper.width = el.width + childMetrics.indentStart;
            wrapper.height = el.height;
            innerStack.add(wrapper);
          }
        }

        const contentHeight = innerStack.height || 20;
        const background = new ContainerBackground(
          availableWidth,
          contentHeight,
          t.containerBgColor,
          t.containerRadius,
        );
        const border = new QuoteBorder(contentHeight, accent, t.containerBorderWidth);

        const wrapper = new MarkdownContainer();
        background.x = 0;
        background.y = 0;
        wrapper.add(background);
        border.x = 0;
        border.y = 0;
        wrapper.add(border);
        innerStack.x = 0;
        innerStack.y = 0;
        wrapper.add(innerStack);
        wrapper.width = availableWidth;
        wrapper.height = Math.max(background.height, border.height, innerStack.height);

        return wrapper;
      }

      // ── Lists ────────────────────────────────────────────────
      case 'list': {
        const listToken = token as Tokens.List;
        const listStack = new Stack({
          direction: 'vertical',
          gap: this.theme.listGap,
        });
        for (let i = 0; i < listToken.items.length; i++) {
          // An item holding a block child cannot be one `RichText`. Tiered so the
          // inline-only case — the overwhelming majority, and the one
          // `updateStreamedList` reuses via `setSpans` — keeps its single entity.
          listStack.add(
            this.itemIsInlineOnly(listToken.items[i])
              ? this.listItemRichText(listToken, i, availableWidth, t)
              : this.listItemBlockStack(listToken, i, availableWidth, t),
          );
        }
        return listStack;
      }

      // ── Table ────────────────────────────────────────────────────────
      case 'table': {
        const tblToken = token as Tokens.Table;

        const headers = tblToken.header.map((cell) => this.tableCellRichText(cell, true, t));
        const rows = tblToken.rows.map((row) =>
          row.map((cell) => this.tableCellRichText(cell, false, t)),
        );

        return this.withBlockAffordances(
          new Table({
            headers,
            rows,
            // `| :--- | :---: | ---: |` already resolves to this on the token; it
            // was previously discarded, so every column rendered left-aligned.
            align: tblToken.align,
            width: availableWidth,
            textColor: t.textColor,
            headerTextColor: t.headingColor,
            font: `${t.tableFontSize}px ${t.bodyFont}`,
            borderColor: t.hrColor,
            bg: t.tableBgColor,
            headerBg: t.tableHeaderBgColor,
            selectable: this.selectable,
          }),
          () => this.tableAffordances(tblToken),
        );
      }

      // ── Footnote definition (`[^1]: note`) ───────────────────────────
      case 'footnoteDef': {
        // Rendered WHERE IT STANDS, as its own block, rather than being collected
        // into a document-end footer. Both are defensible and the choice is
        // silent, so it is written down here.
        //
        // A footer would have to be an entity belonging to no token, which breaks
        // the one invariant this file leans on hardest: `updateTokens` maps token
        // indices to child-entity indices, and `producesEntity` exists precisely
        // because a mismatch there updates or destroys the WRONG entity. A
        // synthesized trailing child is exactly that mismatch, and it would have
        // to be maintained across every streamed append.
        //
        // In place also costs the reader almost nothing: definitions are
        // conventionally written at the bottom of the document already, so this
        // renders them roughly where a footer would put them, and it stays correct
        // when they are not. Nothing is silently dropped and nothing is
        // synthesized.
        const fnToken = token as FootnoteDefToken;
        const headerSpans: StyledSpan[] = [
          {
            text: footnoteMarker(fnToken.label),
            style: { color: t.footnoteColor },
          },
          { text: ' ' },
        ];
        if (fnToken.body) headerSpans.push({ text: decodeEntities(fnToken.body) });
        const headerRichText = new RichText(headerSpans, {
          font: bodyFont,
          color: t.textColor,
          maxWidth: availableWidth,
          selectable: this.selectable,
        });

        // Single-line definition (the overwhelming majority): the old shape.
        // A continuation body only exists when the source actually had one.
        if (!fnToken.tokens || fnToken.tokens.length === 0) {
          return headerRichText;
        }

        // Multi-paragraph definition: header RichText + continuation blocks
        // indented under it, wrapped in a Stack. Same shape as `listItemBlockStack`
        // and blockquote — each continuation child is a MarkdownContainer with
        // `el.x = indent` so the Stack does not overwrite the offset.
        const indent = Math.round(t.fontSize);
        const childMetrics: BlockMetrics = {
          marginBefore: 0,
          marginAfter: 0,
          indentStart: indent,
          availableWidth: Math.max(1, availableWidth - indent),
        };
        const stack = new Stack({ direction: 'vertical', gap: t.listItemGap });
        stack.add(headerRichText);
        for (const inner of fnToken.tokens) {
          const el = this.renderTokenWithMetrics(inner, childMetrics);
          if (!el) continue;
          const wrapper = new MarkdownContainer();
          el.x = indent;
          wrapper.add(el);
          wrapper.width = el.width + indent;
          wrapper.height = el.height;
          stack.add(wrapper);
        }
        return stack;
      }

      // ── Horizontal rule ──────────────────────────────────────────────
      case 'hr':
        return new HorizontalRule(availableWidth, t.hrColor);

      // ── Whitespace ───────────────────────────────────────────────────
      case 'space':
        return null;

      // ── HTML (Support raw SVGs) ──────────────────────────────────────
      case 'html': {
        const htmlToken = token as Tokens.HTML;
        if (
          htmlToken.text.toLowerCase().includes('<svg') &&
          htmlToken.text.toLowerCase().includes('</svg>')
        ) {
          return new SVGEntity(htmlToken.text);
        }
        return null;
      }

      // ── Fallback ─────────────────────────────────────────────────────
      default:
        if ('text' in token) {
          return new Text((token as any).text, {
            font: bodyFont,
            color: t.textColor,
            maxWidth: availableWidth,
            lineHeight: t.bodyLineHeight,
            selectable: this.selectable,
          });
        }
        return null;
    }
  }

  /** Structural — children draw themselves. */
  public render(_r: IRenderer): void {}
}
