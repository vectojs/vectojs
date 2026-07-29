---
'@vectojs/markdown': minor
---

Add `Markdown.createStream()` for frame-coalesced, backpressured token streams.

The lifecycle-bound controller batches accepted chunks into at most one parse/layout commit per animation frame, supports optional fixed-rate grapheme pacing, final flush, `AbortSignal`, and deterministic destroy cleanup, while the existing `appendMarkdown()` API remains synchronous.
