---
"@vectojs/core": minor
---

Add `SceneOptions.contentSemanticBudget`: how many resident (coarse-tier) blocks
may be materialized in one sync, spreading the document-open cost of a wide
`contentSemanticMargin` across frames instead of paying it in a single
synchronous pass.

The cost of a resident tier is per node **created** (~13µs), not per node held —
10000 resident blocks cost 2.470 ms/sync at steady state — so the front-load is a
scheduling problem. Remaining blocks materialize on subsequent syncs until the
document is fully resident; the end state is identical, only reached later, so no
text is ever dropped.

The budget applies only to the coarse tier. A block inside the interaction margin
is on screen and materializes immediately regardless, since deferring visible text
would leave it briefly unselectable. An update to a block that already has DOM is
never deferred either, which would serve stale text.

`Infinity` restores one synchronous pass. Because the coarse tier exists only when
`contentSemanticMargin` is wider than `contentProjectionMargin`, a scene that does
not opt into a resident tier has no budgetable blocks and is unaffected.
