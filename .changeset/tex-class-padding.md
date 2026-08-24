---
'@vectojs/tex': patch
---

Fixes #696: class-carried horizontal padding is now applied when measuring. `.x-arrow-pad`, `.cd-arrow-pad`, `.boxpad`, `.cancel-pad` and `.anglpad` carry their padding purely in katex.scss, so rows measured short by exactly that padding (`\xrightarrow{\text{very long label here}}` 5.858 → 6.558 em; `\boxed{x}` 0.572 → 1.172 em). The padding resolves against the carrying span's sizing ratio like every other em length. `.cancel-lap`'s −0.2em margins are applied with it so `\cancel` keeps its net advance while its ink window grows.
