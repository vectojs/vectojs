---
"@vectojs/markdown": minor
---

Parse YAML front matter off the document instead of rendering it as content.

`marked` has no notion of front matter, so a document opening `---\ntitle: A\n---` lexed as a thematic break followed by a **setext heading** — the closing `---` underlines the keys. The document therefore painted a horizontal rule plus a 28px bold heading made of its own metadata. It is now stripped ahead of the lexer and exposed instead:

- `md.frontMatter` — the block's verbatim contents, unparsed.
- `md.frontMatterFields` — top-level scalar `key: value` pairs. A narrow convenience, not YAML: indented lines are skipped, so nested mappings and sequences do not leak out as top-level keys.
- `scanFrontMatter(text, complete)` and `parseFrontMatterFields(raw)` are exported for use on raw text.

Recognition is deliberately conservative, because a false positive silently deletes the top of a document. A leading `---` is front matter only when the next line is a YAML mapping entry (`key: value`, whitespace after the colon as YAML requires) and a closing `---` or `...` follows. So `---\n\n# Title`, `---\n# Title\n---`, `----\nkey: v\n----` and `---\n- a\n---` all keep rendering a thematic break as before.

Streaming is handled: a chunk that lands inside an unclosed block is held rather than lexed, so the document does not paint a rule that the closing delimiter then has to tear down. A block still open when the stream closes is released as content — which is what `marked` produced all along — and the hold is bounded, so a thematic break at the top of a long document cannot stall it.
