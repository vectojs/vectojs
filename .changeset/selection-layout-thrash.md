---
"@vectojs/core": patch
---

Stop the content projection from forcing a synchronous layout once per rebuilt
element. Every rebuild asked the document whether it owned the current text
selection, and reading any `Selection` property makes the browser lay out the page
first — so materializing a document's worth of resident blocks paid one full
layout of the (growing) projection subtree per block, making per-block cost rise
with how many blocks were already present.

The answer cannot change during a sync walk: a selection is a single
document-wide object and the walk never yields to the user. It is now resolved
once per walk instead of once per element.

Measured in real Chrome over a 1000-block resident document: 2002 forced layouts
became 19 (one per pass), layout work dropped from 800 ms to 66.8 ms, and the full
materialization went from ~337 ms to 52.3 ms. Per-pass cost also stopped climbing
with the number of blocks already materialized — previously 17 → 26 ms as the
document filled in, now flat at 1.1–2.3 ms.

This affects any scene that projects selectable text, and most visibly one using a
wide `contentSemanticMargin`, where a whole document is materialized at once.
