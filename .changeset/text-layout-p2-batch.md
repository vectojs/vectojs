---
'@vectojs/text': patch
'@vectojs/layout': patch
---

Four P2 fixes from the 2026-08-13 review:

- `ArabicShaper` now forms the Lam-Alef ligature across intervening harakat (`لَأ` → `ﻷ` + fatha instead of a colliding Lam/Alef pair).
- `suppressLineBreaks` merges orphan punctuation only onto a non-whitespace word, so `"word !"` can no longer push the `!` onto a line start.
- Rich-text memo keys now carry `lineThrough` (and the streaming style compare carries `lineThrough`/`underline`/`highlightColor`/`abbrTitle`), so a cached paragraph is not reused across a style toggle.
- `computeMSDFLayout` now truncates output at `maxHeight`, mirroring the main-thread `LayoutEngine` gate.
