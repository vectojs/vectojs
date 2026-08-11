---
'@vectojs/core': patch
---

fix(core): MSDFTextEntity content projection now pins the DOM mirror to the canvas row rhythm — `baseline = ascender × fontSize` and `lineHeight = (ascender − descender) × fontSize` from the font metrics are always emitted (the previous projection left line-height to Scene's 16px default and the baseline unaligned), and once a layout reply lands with unshaped LTR glyphs, per-line carriers position each row exactly on the painted baselines. Bidi/shaping/soft-hyphen/justified text keeps the coarse alignment rather than risk wrong geometry.
