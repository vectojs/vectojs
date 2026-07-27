---
'@vectojs/markdown': patch
---

Stop re-deriving the token prefix the worker already computed.

The worker calculates the raw-equal prefix length to decide which token tail to
send, then `updateTokens` re-scanned every token's `raw` string on the main thread
to compute the same number. It now takes the worker's value.

Validated rather than trusted: a value outside either token array would make the
prefix slice reuse entities that do not correspond to the new tokens, so an
out-of-range hint falls back to scanning.

Token counts are far below character counts, so this is a small saving — but it was
duplicated work on every streamed chunk.
