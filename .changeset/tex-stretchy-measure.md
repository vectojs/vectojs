---
'@vectojs/tex': patch
---

Fixes #665: multi-piece stretchy overlays (`\overbrace`, `\underbrace`, `\xleftrightarrow`, …) measured 800–1200 em because each absolutely-positioned piece's declared `"width: 400em"` was taken as literal advance. Pieces of `.halfarrow-*`/`.brace-*` spans are now recorded as pending overlay paths that advance nothing and resolve their slice window (uniform cover scale, per-piece `preserveAspectRatio` alignment, clipped to the window) against the enclosing container extent once known. `\overbrace{x+y}` measures 1200.000 em → 2.320 em; `\sqrt` and other single-path `hide-tail` constructs are untouched.
