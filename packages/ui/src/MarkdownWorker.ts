import { marked } from 'marked';

marked.use({
  extensions: [
    {
      name: 'inlineMath',
      level: 'inline',
      start(src) {
        return src.match(/\$/)?.index;
      },
      tokenizer(src) {
        const match = /^\$([^$]+)\$/.exec(src);
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

self.onmessage = (e: MessageEvent) => {
  // A dedicated worker only receives messages from the script that created it
  // (there is no cross-origin `postMessage` surface — `event.origin` is always
  // "" here), so origin verification does not apply. What *is* worth doing is
  // validating the message SHAPE before acting on it: ignore anything that
  // isn't our `{ id, text }` request so a malformed post can't drive the lexer
  // with a non-string or crash the handler.
  const data = e.data;
  if (typeof data !== 'object' || data === null) return;
  const { id, text, oldRaws } = data as { id: unknown; text: unknown; oldRaws?: unknown };
  if (typeof text !== 'string') return;
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
    if (Array.isArray(oldRaws)) {
      const minLen = Math.min(oldRaws.length, tokens.length);
      for (; matchLen < minLen; matchLen++) {
        if (oldRaws[matchLen] !== tokens[matchLen].raw) break;
      }
    }
    self.postMessage({ id, matchLen, tail: tokens.slice(matchLen) });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
