---
"@vectojs/core": minor
"@vectojs/ui": patch
---

Add forced-colors (Windows High Contrast) awareness. `Scene` now exposes a
`forcedColors` getter backed by a `(forced-colors: active)` media query and
repaints when it toggles, so components can swap to CSS system colors — canvas
pixels are exempt from the browser's forced-colors remapping. `Button` uses it
to draw with `ButtonFace`/`ButtonText`/`Highlight` under High Contrast.
