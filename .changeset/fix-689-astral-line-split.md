---
'@vectojs/core': patch
---

core: MSDFTextEntity no longer splits astral (surrogate-pair) characters across projected accessibility lines (#689). The glyph→source map is now built per code point with proper pair-aware end offsets, so a line break at an emoji can never project lone surrogates into the DOM carriers — copy/paste, in-page find, and screen readers see exactly the rendered text.
