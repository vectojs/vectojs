---
'@vectojs/tex': patch
---

Fixes #667: `\phase` measured 400 em wide. Its angle SVG declares `width: "400em"` and the `hide-tail` wrapper writes only `style.height`, so — unlike `\sqrt`, which inlines a `minWidth` — no clip extent existed and the emitter advanced the full declared width. A hide-tail wrapper without an inline extent now records its child as a pending full-window overlay (left-aligned slice, like `\cancel`) resolved against the container extent: `\phase{-120}` measures 400.000 em → 2.807 em.
