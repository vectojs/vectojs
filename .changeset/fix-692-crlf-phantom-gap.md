---
'@vectojs/core': patch
---

core: CRLF text now takes the coarse a11y projection instead of the fine per-line one (#692). The layout worker breaks lines on `\n` only, so a surviving `\r` glyph passed the fine-projection guard and rendered a phantom ~1em advance at every CRLF line end; any `\r` in the source now forces the coarse fallback, as the guard's contract already promised.
