---
'@vectojs/tex': patch
---

Fixes #697: array vertical rules (`{c|c}`, `{c:c}`) now draw. Separator spans write their rule as `style.borderRightWidth`/`borderRightStyle`, which the emitter dropped — only `borderBottomWidth` rules survived #514's generalization. `.vertical-separator` spans now emit a stroked line centred on the column boundary spanning the table height (recovered from the span's `height` and `verticalAlign`), with a dash pattern for `:` separators, advancing nothing like their CSS border-box geometry.
