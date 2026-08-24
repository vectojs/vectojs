---
'@vectojs/three': patch
---

parseFontSize now converts every unit the font-shorthand grammar admits. `rem`/`em` resolve against the CSS 16px root default and `pt` against 4/3 px; previously the unit was discarded, so '1.5em Inter' rasterized ~24px glyphs into a 3px strip with a collapsed baseline while Canvas2D rendered the same string correctly.
