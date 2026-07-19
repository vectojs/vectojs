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
  const { id, text, oldRaws } = e.data;
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
