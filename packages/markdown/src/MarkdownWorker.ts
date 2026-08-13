import { marked, type Token } from 'marked';
import {
  type IncrementalLexCache,
  type IncrementalLexResult,
  lexAppend,
  lexFull,
} from './incrementalLex';
import { ABBR_EXTENSIONS } from './markdown-abbr';
import { CONTAINER_EXTENSIONS } from './markdown-container';
import { EMOJI_EXTENSIONS } from './markdown-emoji';
import { FOOTNOTE_EXTENSIONS } from './markdown-footnote';
import { INS_MARK_EXTENSIONS } from './markdown-ins-mark';
import { SUPERSCRIPT_EXTENSIONS } from './markdown-superscript';

interface WorkerTimingSpan {
  name: string;
  startMark: string;
  endMark: string;
}

let nextTimingSpanId = 0;

function beginUserTiming(name: unknown): WorkerTimingSpan | null {
  if (
    typeof name !== 'string' ||
    typeof performance.mark !== 'function' ||
    typeof performance.measure !== 'function'
  ) {
    return null;
  }
  const id = nextTimingSpanId++;
  const span = {
    name,
    startMark: `${name}:start:${id}`,
    endMark: `${name}:end:${id}`,
  };
  try {
    performance.mark(span.startMark);
    return span;
  } catch {
    return null;
  }
}

function endUserTiming(span: WorkerTimingSpan | null): void {
  if (!span) return;
  try {
    performance.mark(span.endMark);
    performance.measure(span.name, span.startMark, span.endMark);
  } catch {
    // Optional diagnostics must not break parsing.
  } finally {
    try {
      performance.clearMarks?.(span.startMark);
      performance.clearMarks?.(span.endMark);
    } catch {
      // Optional diagnostics must not break parsing.
    }
  }
}

marked.use({
  // Shared with `Markdown.ts`'s registration — see the lockstep note there and in
  // `markdown-footnote.ts`. esbuild inlines this import into the worker bundle.
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
        // content may span lines; the first closing `$$` or a blank line ends
        // it.
        //
        // **Blank-line termination**: `(?:(?!\n[ \t]*\n)[\s\S])+?` stops at the
        // first blank line (including whitespace-only lines) or closing `$$`.
        // Kept in lockstep with Markdown.ts's blockMath tokenizer.
        //
        // This must exist as a *block* rule. The inline `inlineMath` rule below
        // deliberately refuses `$$` to protect currency ('$5 to $10'), so with
        // no block rule marked's text tokenizer consumes the leading `$`, the
        // inline rule then matches the inner `$...$` pair, and the outer two
        // dollars are painted as literal text on either side of the formula.
        const match = /^ {0,3}\$\$((?:(?!\n[ \t]*\n)[\s\S])+?)\$\$[ \t]*(?:\n|$)/.exec(src);
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
        // Keep in lockstep with Markdown.ts's inlineMath tokenizer: guard
        // against currency ("$5 to $10"), `$$`, and trailing digits so only
        // real inline math ("$x+1$") tokenizes.
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

/**
 * Per-Markdown-instance lex state: everything needed to extend this instance's
 * document without re-reading or re-lexing what it already covers.
 *
 * The {@link IncrementalLexCache} carries the accumulated source, the token list,
 * and the stable block boundary. Caching the source is what takes main->worker
 * transfer from O(document) per chunk (O(N²) over a stream) down to O(chunk),
 * since a steady-state append ships only the new text. Caching the boundary is
 * what does the same for the lex itself — the cost this protocol used to pay in
 * full on every chunk.
 *
 * The token list is held rather than a parallel array of raw strings: the prefix
 * match needs `raw` values, and reading them off the tokens avoids rebuilding an
 * O(document) array per chunk. It also means the tokens spliced into the next
 * response are the same objects, so the prefix comparison short-circuits on
 * pointer equality.
 *
 * `version` is the caller's token-list version this cache is valid for. The
 * caller bumps its version on every token-list mutation it makes, so a mismatch
 * (first request, a `setContent()`, or a main-thread sync-fallback parse that
 * the worker never saw) means the cache cannot be trusted — the worker asks for
 * one resync rather than silently diffing against stale tokens or, worse, lexing
 * a source that has silently diverged from the caller's.
 */
const rawCache = new Map<string, { version: number; lex: IncrementalLexCache }>();

/**
 * Hard bound on per-instance cache entries. An instance GC'd without `destroy()`
 * never sends `dispose`, so the worker-side map used to grow with every
 * Markdown block a long-lived page ever created — and each entry holds the
 * instance's full accumulated source plus its token tree. Bounded by
 * oldest-entry eviction (Map insertion order): an actively-streaming instance
 * re-touches its entry on every chunk, so eviction only ever reclaims the
 * longest-idle ones, at the cost of one resync if one of those returns.
 *
 * Exported for the protocol test, which drives the real worker module and must
 * know where the bound sits to assert the eviction. esbuild strips it from the
 * embedded worker bundle.
 */
export const RAW_CACHE_MAX = 256;

self.onmessage = (e: MessageEvent) => {
  // A dedicated worker only receives messages from the script that created it
  // (there is no cross-origin `postMessage` surface — `event.origin` is always
  // "" here), so origin verification does not apply. What *is* worth doing is
  // validating the message SHAPE before acting on it: ignore anything that
  // isn't one of our request shapes (`{ id, text }` or `{ id, append }`) so a
  // malformed post can't drive the lexer with a non-string or crash the handler.
  const data = e.data;
  if (typeof data !== 'object' || data === null) return;
  const {
    id,
    text,
    append,
    expectedLength,
    oldRaws,
    instance,
    baseVersion,
    dispose,
    userTimingName,
  } = data as {
    id: unknown;
    text?: unknown;
    append?: unknown;
    expectedLength?: unknown;
    oldRaws?: unknown;
    instance?: unknown;
    baseVersion?: unknown;
    dispose?: unknown;
    userTimingName?: unknown;
  };

  // A destroyed Markdown instance releases its cache entry so a long-lived page
  // that creates and drops many blocks doesn't retain their raws forever.
  if (dispose === true) {
    if (typeof instance === 'string') rawCache.delete(instance);
    return;
  }

  const key = typeof instance === 'string' ? instance : null;
  const version = typeof baseVersion === 'number' ? baseVersion : null;

  // Resolve how this request will be lexed, and what the caller currently holds
  // to diff against.
  //
  // Two request shapes. A DELTA request carries only `append` and extends the
  // cached source; a FULL request carries `text`, which is what a first request,
  // a `setContent()`, or a resync sends. Anything the cache cannot satisfy asks
  // for one resync rather than guessing: lexing a source that had silently
  // diverged from the caller's would return a matchLen describing tokens the
  // caller never held, and the reconciler would keep the wrong entities.
  //
  // `runLex` is deferred rather than executed here so the user-timing span and
  // the `lexerMs` measurement wrap exactly the lex and nothing else.
  let runLex: () => IncrementalLexResult;
  // Two shapes of "what the caller holds": a raw-string array it sent us, or the
  // token list we already have for it. Kept separate so the cached case can skip
  // the comparisons the incremental lex has already proven equal.
  let priorRaws: readonly string[] | null = null;
  let priorTokenRaws: readonly Token[] | null = null;

  if (typeof append === 'string') {
    if (key === null || version === null) {
      // A delta is meaningless without the identity and version that say which
      // cached source it extends.
      self.postMessage({ id, needResync: true });
      return;
    }
    const cached = rawCache.get(key);
    if (!cached || cached.version !== version) {
      self.postMessage({ id, needResync: true });
      return;
    }
    // The caller states what the document must total after this append. A
    // mismatch means the two sides disagree about the source — a dropped,
    // duplicated, or reordered chunk — and every token from here on would be
    // lexed from text the caller does not have. One integer to check, and it
    // converts a silent divergence into one resync. Compared by length rather
    // than by concatenating first, so a rejected delta costs no string work.
    if (
      typeof expectedLength === 'number' &&
      cached.lex.source.length + append.length !== expectedLength
    ) {
      rawCache.delete(key);
      self.postMessage({ id, needResync: true });
      return;
    }
    const base = cached.lex;
    runLex = () => lexAppend(base, append);
    // The prior token list IS the cache's, so raws are read straight off it.
    // Building a parallel string array here would put an O(document) allocation
    // back into the per-chunk path that the boundary exists to remove.
    priorTokenRaws = base.tokens;
  } else if (typeof text === 'string') {
    const full = text;
    runLex = () => lexFull(full);
    // The raws just sent (a resync or a cacheless caller) take precedence, else
    // this instance's cached tokens when they match the caller's current version.
    if (Array.isArray(oldRaws)) {
      priorRaws = oldRaws as string[];
    } else if (key !== null && version !== null) {
      const cached = rawCache.get(key);
      if (cached && cached.version === version) {
        priorTokenRaws = cached.lex.tokens;
      } else {
        // Cache miss/stale — ask for the raws once instead of diffing blind (a
        // wrong matchLen would corrupt the caller's reconciled token list).
        self.postMessage({ id, needResync: true });
        return;
      }
    }
  } else {
    // Neither shape — ignore, as a non-string `text` was ignored before.
    return;
  }

  try {
    // Shipping the ENTIRE token tree back over `postMessage` on every call would
    // be a real, escalating cost: structured-cloning an object graph that grows
    // with the whole document, not just the new chunk. The caller already knows
    // which of ITS OWN previous tokens are still valid (raw source unchanged), so
    // diff the same way `updateTokens()` does on the receiving end and send back
    // only the changed suffix.
    //
    // Time the lex itself. It used to be the one cost here that stayed
    // O(document) per chunk while nothing downstream could see it — the reuse
    // counters describe the token DIFF, which is a different thing entirely.
    // `charsLexed` is now what makes the difference visible: it reports the text
    // actually handed to `marked`, which is the unstable tail rather than the
    // document.
    const userTiming = typeof userTimingName === 'string' ? beginUserTiming(userTimingName) : null;
    const lexStart = performance.now();
    let result: IncrementalLexResult;
    try {
      result = runLex();
    } finally {
      if (userTiming) endUserTiming(userTiming);
    }
    const lexerMs = performance.now() - lexStart;
    const tokens = result.tokens;

    // Leading tokens the incremental lex reused are the SAME objects the caller's
    // prior list holds, so their raws are equal by construction and comparing
    // them would be wasted work. Starting the scan at `reusedTokens` is what
    // keeps the prefix match O(window) rather than O(document) — without it the
    // diff would remain linear in the whole token list even though the lex no
    // longer is.
    let matchLen = 0;
    if (priorRaws !== null) {
      const minLen = Math.min(priorRaws.length, tokens.length);
      for (; matchLen < minLen; matchLen++) {
        if (priorRaws[matchLen] !== tokens[matchLen]!.raw) break;
      }
    } else if (priorTokenRaws !== null) {
      const prior = priorTokenRaws;
      const minLen = Math.min(prior.length, tokens.length);
      matchLen = Math.min(result.reusedTokens, minLen);
      for (; matchLen < minLen; matchLen++) {
        if (prior[matchLen]!.raw !== tokens[matchLen]!.raw) break;
      }
    }

    // Remember what the caller will be holding after it applies this response,
    // tagged with the version it will then be at, plus the lex state those tokens
    // came from — so the next chunk needs to send neither the prior raws nor the
    // document, only the new text, and needs to lex only what follows the stable
    // boundary.
    if (key !== null && version !== null) {
      // Delete-then-set re-touches the entry so insertion order doubles as
      // recency; the eviction below then drops the longest-idle instance,
      // never the one that is still streaming.
      rawCache.delete(key);
      rawCache.set(key, { version: version + 1, lex: result.cache });
      if (rawCache.size > RAW_CACHE_MAX) {
        rawCache.delete(rawCache.keys().next().value!);
      }
    }
    self.postMessage({
      id,
      matchLen,
      tail: tokens.slice(matchLen),
      lexerMs,
      sourceCharsLexed: result.charsLexed,
    });
  } catch (err) {
    // The cached tokens no longer describe anything the caller can trust.
    if (key !== null) rawCache.delete(key);
    self.postMessage({ id, error: String(err) });
  }
};
