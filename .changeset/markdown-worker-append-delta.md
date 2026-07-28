---
"@vectojs/markdown": minor
---

Stream markdown to the worker as an append delta instead of the whole document

A streamed `appendMarkdown()` used to post the entire accumulated `rawMarkdown`
on every chunk, so the structured clone charged to the caller's thread grew with
the document: O(N) per chunk, O(N²) per stream. The worker now owns the source
text alongside the raw list it already kept (keyed by instance + token version),
and a steady-state request carries only `{ append, expectedLength }`.

Measured on real hardware, per-append main-thread `postMessage` cost on Chrome
drops from 4.08µs at 8KB / 34.54µs at 128KB / 219.68µs at 512KB to a flat
2.07–2.50µs at every size. Whole-stream main-thread time saved: ~3ms at 32KB,
~68ms at 128KB, ~1.8s at 512KB (Firefox: ~3ms / ~30ms / ~680ms). The lex itself
is unchanged — `marked` has no incremental lexer — but it runs off-thread,
whereas the transfer did not.

The caller tracks how much source the worker holds and sends the full text plus
`oldRaws` whenever that is unknown: the first request, after `setContent()`, and
after a local sync-fallback parse. The worker validates every delta against
`expectedLength` and its cached token version, and answers `needResync` (dropping
its cache entry) if either disagrees, so a lost or reordered request costs one
round trip rather than corrupting the document. A first request now carries the
text and the raws together instead of being answered with `needRaws` and sending
the document a second time.

No API change: `appendMarkdown()`, `setContent()`, and `destroy()` behave as
before.
