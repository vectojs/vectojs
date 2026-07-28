---
'@vectojs/devtools': minor
---

Draw the selection highlight as geometry layers instead of one bounding box.

The panel drew only the world AABB, so a rotated entity showed its bounding box
rather than its true edges, and every other box it carries was invisible. Those
boxes diverging from each other is the bug class the highlight exists to reveal.

`highlightGeometry()` returns the layout quad, `getBounds()` render box, nearest
clipping ancestor, projected content bounds and accessibility bounds, each as a
true polygon in scene coordinates and each flagged when it drifts from the layout
box. `setHighlightLayers()` chooses what the panel draws; the default stays the
single AABB so an existing screenshot reads the same.

`sampleHitRegion()` covers the one layer that has no retrievable geometry:
`isPointInside` is a predicate, so the region is approximated by probing a grid
and emitting one span per scanline. It is off by default because cost is
quadratic in the entity's size, and it compares by area coverage rather than
extent — a circle inscribed in its box has exactly the box's extent while
accepting ~79% of its points, so an extent check reports the most common
divergence as none.
