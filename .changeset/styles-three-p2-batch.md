---
'@vectojs/styles': patch
'@vectojs/three': patch
---

Make `setTheme` atomic on token-resolution failure: every tracked style is now resolved against the next theme before the active theme changes, so a theme missing a referenced token throws while the scene, theme and pair bookkeeping stay fully under the previous theme (previously entities were left half-restyled and pairs half-migrated). And fix `ThreeRenderer.fillText` placement: parse the size out of the weight-first font shorthand (`'700 16px Inter'` produced a 1050px texture before), keep the raster texture unflipped so glyphs stay upright under the y-down ortho camera, draw the plane double-sided so it survives the mirrored projection's culling, and position the mesh so the alphabetic baseline lands exactly at the Canvas2D `y`.
