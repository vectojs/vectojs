import { marked } from 'marked';

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
 * Per-Markdown-instance cache of the raw source of the tokens the caller is
 * currently holding, so a streaming append does NOT have to re-send them every
 * chunk (that made each request O(document) on top of the text itself, i.e.
 * O(N²) transfer + main-thread serialization over a whole stream).
 *
 * `version` is the caller's token-list version this cache is valid for. The
 * caller bumps its version on every token-list mutation it makes, so a mismatch
 * (first request, a `setContent()`, or a main-thread sync-fallback parse that
 * the worker never saw) means the cache cannot be trusted — the worker asks for
 * one resync rather than silently diffing against stale raws.
 */
const rawCache = new Map<string, { version: number; raws: string[] }>();

self.onmessage = (e: MessageEvent) => {
  // A dedicated worker only receives messages from the script that created it
  // (there is no cross-origin `postMessage` surface — `event.origin` is always
  // "" here), so origin verification does not apply. What *is* worth doing is
  // validating the message SHAPE before acting on it: ignore anything that
  // isn't our `{ id, text }` request so a malformed post can't drive the lexer
  // with a non-string or crash the handler.
  const data = e.data;
  if (typeof data !== 'object' || data === null) return;
  const { id, text, oldRaws, instance, baseVersion, dispose } = data as {
    id: unknown;
    text: unknown;
    oldRaws?: unknown;
    instance?: unknown;
    baseVersion?: unknown;
    dispose?: unknown;
  };

  // A destroyed Markdown instance releases its cache entry so a long-lived page
  // that creates and drops many blocks doesn't retain their raws forever.
  if (dispose === true) {
    if (typeof instance === 'string') rawCache.delete(instance);
    return;
  }

  if (typeof text !== 'string') return;
  const key = typeof instance === 'string' ? instance : null;
  const version = typeof baseVersion === 'number' ? baseVersion : null;

  // Resolve which prior raws to diff against: the ones just sent (a resync or a
  // cacheless caller) take precedence, else this instance's cached raws when
  // they match the caller's current version.
  let priorRaws: string[] | null = null;
  if (Array.isArray(oldRaws)) {
    priorRaws = oldRaws as string[];
  } else if (key !== null && version !== null) {
    const cached = rawCache.get(key);
    if (cached && cached.version === version) {
      priorRaws = cached.raws;
    } else {
      // Cache miss/stale — ask for the raws once instead of diffing blind (a
      // wrong matchLen would corrupt the caller's reconciled token list).
      self.postMessage({ id, needRaws: true });
      return;
    }
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
    const tokens = marked.lexer(text);
    let matchLen = 0;
    if (priorRaws) {
      const minLen = Math.min(priorRaws.length, tokens.length);
      for (; matchLen < minLen; matchLen++) {
        if (priorRaws[matchLen] !== tokens[matchLen].raw) break;
      }
    }
    // Remember what the caller will be holding after it applies this response,
    // tagged with the version it will then be at, so the next chunk needs to
    // send only the new text.
    if (key !== null && version !== null) {
      rawCache.set(key, {
        version: version + 1,
        raws: tokens.map((t) => t.raw),
      });
    }
    self.postMessage({ id, matchLen, tail: tokens.slice(matchLen) });
  } catch (err) {
    // The cached raws no longer describe anything the caller can trust.
    if (key !== null) rawCache.delete(key);
    self.postMessage({ id, error: String(err) });
  }
};
