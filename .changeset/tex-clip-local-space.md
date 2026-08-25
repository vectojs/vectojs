---
'@vectojs/tex': patch
---

Fix stretchy overlay/clip render windows in SVG emit (#787, #788): `clipPath` rects are now emitted in the referencing path's own coordinate frame (SVG resolves them post-transform), and the aligned-vlist replay translates a recorded clip alongside the path it bounds. `\overbrace`/`\underbrace` middle and right pieces, nested `\phase`, and clipped radicals after a row advance or under a non-1 scale render their full visible window again instead of being displaced or partially eaten.
