---
'@vectojs/tex': patch
---

Pin sliced-radical clip windows with renderer-geometry regression tests (#788): `\sqrt{x^2+y^2}` under a non-1 `sy` and `\frac{\sqrt{x}}{y}` (replayed aligned row, `sx = sy = 0.7`) now assert from the emitted SVG that the effective rendered window coincides with the path's own placement box. Also corrects the vlist replay soundness comment, which claimed clip translation was sound before it actually translated clips.
