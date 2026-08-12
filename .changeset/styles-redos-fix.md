---
'@vectojs/styles': patch
---

Fix the polynomial-redos code-scanning alert (js/polynomial-redos) on the font
size parser: the `(\d+\.?\d*|\.\d+)` number pattern overlapped adjacent digit
classes, so a long digit run with a non-unit suffix backtracked in O(n²).
Replaced with `(?:\d+(?:\.\d*)?|\.\d+)` (digit class separated by a literal
dot) and reordered the unit alternation so `em`/`rem` is never a prefix pair —
long malformed values now fail in linear time.
