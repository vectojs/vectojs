---
'@vectojs/layout': patch
---

Inline-object metrics are now honored by the fast paths: `measurePrepared` and `layoutPreparedIntoBuffer` run the same object loops as the allocating path (pMax ascent growth + descent line extension), and the buffer path stores `object.height` with the object-based y instead of treating U+FFFC as an ordinary fontSize glyph. Measured rows and buffer-rendered text no longer clip tall inline formulas/images.
