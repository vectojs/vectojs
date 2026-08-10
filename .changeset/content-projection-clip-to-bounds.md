---
'@vectojs/core': minor
---

Add `ContentProjection.clipToBounds` so a clipping entity's DOM copy clips too

The content-projection element is deliberately unclipped, which is load-bearing:
it lets a drag-selection start in an entity's padding and extend past its bounds.
But an entity whose own `render()` clips then disagrees with its own DOM copy —
the canvas stops at the box while the transparent selection carriers keep going,
so selecting content wider than the box paints browser highlight across whatever
is drawn beside it. Measured in real Chromium at `innerWidth` 1566: a carrier of a
horizontally scrollable code block extended to x=1580, and the selection band painted
over the prose and table-of-contents to its right.

Setting `clipToBounds: true` on a projection now confines the mirror's paint to
the entity box. Implemented with `clip-path: inset(...)` rather than `overflow`,
so the element does not become a scroll container and where a selection may
_begin_ is unchanged — only where it _paints_. The inset is expressed in the
element's own coordinates, which are offset from the entity box by the
projection's `contentX`/`contentY`, so a padded or baseline-shifted projection
still clips exactly to the entity's edges.

Off by default: an entity that does not clip its own drawing keeps the previous
unclipped element, byte-for-byte.
