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

const TRUSTED_ORIGIN = self.location.origin;

self.onmessage = (e: MessageEvent) => {
  if (e.origin && e.origin !== TRUSTED_ORIGIN) {
    return;
  }

  const { id, text } = e.data;
  try {
    const tokens = marked.lexer(text);
    self.postMessage({ id, tokens });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
