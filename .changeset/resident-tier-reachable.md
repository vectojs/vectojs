---
"@vectojs/core": patch
---

Fix the resident semantic tier being unreachable. With `contentSemanticMargin`
wider than `contentProjectionMargin`, an off-viewport block kept its full text in
the DOM but was given `display: none` — and `display: none` text is skipped by
native find-in-page and absent from the accessibility tree, so the tier delivered
a DOM node and none of the findability it exists for.

The cause was an implication rather than a coincidence: a coarse-tier block is by
definition outside the interaction margin, and every margin is `>= 0`, so it also
failed the exact (margin 0) visibility test that drives `display`.

Blocks in a scene that opted into a wider semantic margin now stay displayed when
the _viewport_ is what rejects them. This is safe because the a11y root is
viewport-sized, `overflow: hidden` and not scrollable, so such text is clipped
rather than painted and a find match cannot scroll the projection layer out of
alignment with the canvas. A block rejected by a `clipChildren` ancestor whose own
box overlaps the viewport still gets `display: none`, since that text would sit on
top of whatever is really drawn there.

The default configuration is unchanged: without a wider semantic margin there is
no coarse tier, and `display` remains exactly the previous viewport test.
