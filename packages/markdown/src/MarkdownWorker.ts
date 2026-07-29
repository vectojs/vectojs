import { marked, type TokensList } from 'marked';

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
  extensions: [
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
 * Per-Markdown-instance cache of what the caller is currently holding: the raw
 * source of its tokens, and the accumulated document source itself.
 *
 * `raws` exists so a streaming append does NOT have to re-send every prior
 * token's raw text each chunk. `source` exists so it does not have to re-send
 * the DOCUMENT each chunk either — with both cached, a steady-state append ships
 * only the new chunk, which is what takes main->worker transfer from
 * O(document) per chunk (O(N²) over a stream) down to O(chunk).
 *
 * `version` is the caller's token-list version this cache is valid for. The
 * caller bumps its version on every token-list mutation it makes, so a mismatch
 * (first request, a `setContent()`, or a main-thread sync-fallback parse that
 * the worker never saw) means the cache cannot be trusted — the worker asks for
 * one resync rather than silently diffing against stale raws or, worse, lexing a
 * source that has silently diverged from the caller's.
 */
const rawCache = new Map<string, { version: number; raws: string[]; source: string }>();

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

  // Resolve the source to lex and the prior raws to diff against.
  //
  // Two request shapes. A DELTA request carries only `append` and extends the
  // cached source; a FULL request carries `text`, which is what a first request,
  // a `setContent()`, or a resync sends. Anything the cache cannot satisfy asks
  // for one resync rather than guessing: lexing a source that had silently
  // diverged from the caller's would return a matchLen describing tokens the
  // caller never held, and the reconciler would keep the wrong entities.
  let source: string;
  let priorRaws: string[] | null = null;

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
    source = cached.source + append;
    // The caller states what the document must total after this append. A
    // mismatch means the two sides disagree about the source — a dropped,
    // duplicated, or reordered chunk — and every token from here on would be
    // lexed from text the caller does not have. One integer to check, and it
    // converts a silent divergence into one resync.
    if (typeof expectedLength === 'number' && source.length !== expectedLength) {
      rawCache.delete(key);
      self.postMessage({ id, needResync: true });
      return;
    }
    priorRaws = cached.raws;
  } else if (typeof text === 'string') {
    source = text;
    // The raws just sent (a resync or a cacheless caller) take precedence, else
    // this instance's cached raws when they match the caller's current version.
    if (Array.isArray(oldRaws)) {
      priorRaws = oldRaws as string[];
    } else if (key !== null && version !== null) {
      const cached = rawCache.get(key);
      if (cached && cached.version === version) {
        priorRaws = cached.raws;
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
    // `marked` has no incremental lexing API, so re-lexing the whole
    // accumulated text on every streamed chunk is unavoidable — but shipping
    // the ENTIRE resulting token tree back over `postMessage` on every call
    // is not: structured-cloning a multi-megabyte object graph (this tree
    // grows with the whole document, not just the new chunk) is itself a
    // real, escalating main/worker-thread cost on top of the lex itself.
    // The caller already knows which of ITS OWN previous tokens are still
    // valid (raw source unchanged), so diff the same way `updateTokens()`
    // does on the receiving end and send back only the changed suffix.
    // Time the lex itself. It is the one cost in this pipeline that is still
    // O(document) per chunk, and nothing downstream could see it: the reuse
    // counters describe the token DIFF, which is a different thing entirely.
    const userTiming = typeof userTimingName === 'string' ? beginUserTiming(userTimingName) : null;
    const lexStart = performance.now();
    let tokens: TokensList;
    try {
      tokens = marked.lexer(source);
    } finally {
      if (userTiming) endUserTiming(userTiming);
    }
    const lexerMs = performance.now() - lexStart;
    let matchLen = 0;
    if (priorRaws) {
      const minLen = Math.min(priorRaws.length, tokens.length);
      for (; matchLen < minLen; matchLen++) {
        if (priorRaws[matchLen] !== tokens[matchLen].raw) break;
      }
    }
    // Remember what the caller will be holding after it applies this response,
    // tagged with the version it will then be at, plus the source those tokens
    // came from — so the next chunk needs to send neither the prior raws nor the
    // document, only the new text.
    if (key !== null && version !== null) {
      rawCache.set(key, {
        version: version + 1,
        raws: tokens.map((t) => t.raw),
        source,
      });
    }
    self.postMessage({
      id,
      matchLen,
      tail: tokens.slice(matchLen),
      lexerMs,
      sourceCharsLexed: source.length,
    });
  } catch (err) {
    // The cached raws no longer describe anything the caller can trust.
    if (key !== null) rawCache.delete(key);
    self.postMessage({ id, error: String(err) });
  }
};
