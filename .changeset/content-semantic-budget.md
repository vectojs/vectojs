---
"@vectojs/core": minor
---

Add `SceneOptions.contentSemanticBudget`: how many resident (coarse-tier) blocks
may be materialized in one sync, spreading the document-open cost of a wide
`contentSemanticMargin` across frames instead of paying it in a single
synchronous pass.

The front-load is a scheduling problem: a resident tier costs little to hold
(10000 resident blocks measure 2.470 ms/sync at steady state) but a document's
worth of blocks all materialize in the first sync. Remaining blocks now arrive on
subsequent syncs until the document is fully resident; the end state is identical,
only reached later, so no text is ever dropped.

The default is 256 blocks per sync, sized against two measured costs: creating one
block is cheap and flat (~0.03 ms), while style and layout of the projection
subtree scales with how many blocks are already resident and is paid once per pass.
Total cost is therefore roughly `passes × f(resident)`, so a smaller budget
multiplies the term that does not shrink — at 10000 blocks, budget 32 takes 3773 ms
to complete versus 648 ms at 256, with no improvement in worst-pass time (42.6 ms
vs 35.2 ms, both bounded by the final pass laying out the complete subtree).

The budget applies only to the coarse tier. A block inside the interaction margin
is on screen and materializes immediately regardless, since deferring visible text
would leave it briefly unselectable. An update to a block that already has DOM is
never deferred either, which would serve stale text.

`Infinity` restores one synchronous pass. Because the coarse tier exists only when
`contentSemanticMargin` is wider than `contentProjectionMargin`, a scene that does
not opt into a resident tier has no budgetable blocks and is unaffected.
