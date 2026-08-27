---
'@vectojs/tex': patch
---

Fix math-foundations glyph whitelist holes: add setminus (U+2216), bigcup display variant (Size2 U+22C3), literal underscore (U+005F) and overline hit-test block to the subset corpus. Previously those display blocks degraded to raw TeX source (blue CodeBlock) instead of typeset SVG. Also pin the 666-glyph count in the binary codec guard.
