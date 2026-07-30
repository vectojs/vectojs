---
"@vectojs/markdown": patch
---

Update a streamed heading in place instead of rebuilding it.

A heading renders to a `RichText` through the same `renderInlineToRichText` a
paragraph uses, so `setSpans` was always available — the reconciler dispatched on
the literal string `'paragraph'` and so destroyed and rebuilt the heading entity on
every chunk, re-shaping its text and forcing a full `Stack.layout()`.

Reuse is guarded on unchanged heading depth: `RichText.setSpans` replaces the runs
but does not touch `font`, which is constructor-only, and a heading's font size is
derived from its depth. Streaming `#` then `# T` lexes to `## T`, moving the same
token index from depth 1 to depth 2, so that case still rebuilds.

Measured on real hardware (`benchmarks/markdown-stream-phases`, new `headings`
shape, two runs per arm): reconcile time for a word-at-a-time heading fell from
21.2/21.0ms to 11.1/10.7ms in Chrome and 12.2ms to 9.2ms in Firefox. Behaviour is
unchanged; this is purely a reuse path.
