---
'@vectojs/core': patch
---

Re-project a content grid when its line origin moves

`ContentGridProjector` gated its whole carrier rebuild on the grid revision and
the line window, so an entity that scrolls its projected content horizontally
moved every line box without invalidating anything: the source text and each
cell's position _within_ a line are unchanged, only the line origin moves. The
carriers stayed frozen while the canvas glyphs slid underneath, which detaches a
native selection from the text it covers — measured 1017px of divergence at full
scroll.

The projected line origin is now part of the grid signature, so a scroll
re-materializes the carriers in the same frame the glyphs move. Unchanged for
every entity that does not move its content: the origin is constant, so the
signature is too, and the streaming carrier-reuse path is untouched.
