---
'@vectojs/ui': patch
---

Fix `Markdown.updateTokens()` calling a full O(children) `Stack.layout()` on every single streamed chunk, even in the common case where only the actively-growing last paragraph changed (via `setSpans()`) with no other structural change. This bypassed the O(1) `Stack.add()` fast-append path entirely and made per-chunk cost scale with total mounted paragraph count, causing frame rate to degrade progressively as a streamed document grows and leaving the last few frames before completion disproportionately slow. Added `Stack.resizeLastChild()`, an O(1) resync used when the Stack's last child changes its own size in place, and use it from `updateTokens()` instead of the unconditional full `layout()` call.
