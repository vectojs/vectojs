---
'@vectojs/core': minor
---

Split `contentProjectionMargin` into a semantic and an interaction margin.

`contentSemanticMargin` arms the gate that decides whether a content block has
**any** projected DOM; `contentProjectionMargin` now governs only whether that
block's per-line **carriers** are windowed. One scalar armed both, so only two
states were reachable: a finite value freed off-band blocks entirely, leaving
off-screen text invisible to find-in-page and screen-reader read-ahead, while
`Infinity` also unwindowed every carrier — O(total document glyphs).

Setting `contentSemanticMargin: Infinity` with a finite `contentProjectionMargin`
is the middle tier that was previously unreachable: every block keeps an element
holding its full text, while only blocks near the viewport pay for carriers.

Purely additive — `contentSemanticMargin` defaults to whatever
`contentProjectionMargin` resolves to, so existing scenes are unchanged.
