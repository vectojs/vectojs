---
"@vectojs/markdown": patch
---

Stop re-sending the whole prior-token raw list to the Markdown worker on every
streamed chunk. `dispatchAppend` posted `oldRaws` (the raw source of every token
the caller already held) alongside the accumulated `text`, so each chunk shipped
the document **twice** — an extra O(document) transfer + structured-clone per
chunk over a stream.

The worker now caches that raw list itself, keyed by the Markdown instance and
its token version, so a steady-state chunk posts only the text. The version is
bumped on every token-list mutation, so any change the worker didn't produce
(`setContent`, a main-thread sync-fallback parse) invalidates the cache and the
worker asks for one resync (`needRaws`) instead of diffing against stale raws —
a wrong `matchLen` would corrupt the reconciled token list. A destroyed block
tells the worker to drop its entry.

`updateTokens` no longer rebuilds its token-index → child-entity-index map over
every token per chunk: the prefix sum is maintained incrementally (only the
changed suffix is recomputed), and the entity-destroy loop now starts at the
match point instead of scanning from 0 and skipping.

Real-HW (`benchmarks/markdown-stream-transfer`, Chrome 150 + Firefox 153):
posted bytes over a 400-chunk stream drop from 9953 KB to 5002 KB (1.99×). The
remaining growth is the `text` field itself, which cannot shrink while `marked`
has no incremental lexer.
