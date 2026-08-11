---
'@vectojs/core': patch
---

fix(core): TextEntity content projection emits per-line geometry (y/baseline/lineHeight) and source-faithful separators, so the DOM mirror's find-in-page highlight and selection overlap the painted glyphs instead of flowing at CSS normal line-height (~0.35em drift per line, measured in Firefox). Bidi and justified lines keep natural flow; other lines get per-grapheme carriers for Gecko grid-fit correctness.
