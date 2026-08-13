---
'@vectojs/tex': patch
---

Fix `\cancel`/`\bcancel`/`\xcancel` emitting a giant filled rectangle and a ~100em advance. The overlay SVG `stretchyEnclose` produces has `width: 100%` and line endpoints `"100%"`; `parseEm` parsed those as `100em`, so the emitter advanced the pen by 100em and drew a ~100em × 100em filled rect over the formula. The emitter now treats a percentage-width SVG as a zero-advance overlay and draws its `LineNode` diagonals as stroked `<line>` elements, with the percent x-endpoints deferred to the enclosing vlist row's width (mirroring the `fullWidth` rule machinery) and the y-endpoints resolved against the box height.
