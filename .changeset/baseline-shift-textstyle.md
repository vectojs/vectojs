---
'@vectojs/layout': minor
'@vectojs/ui': minor
---

Add a `baselineShift` field to `TextStyle` (px, positive = up), so rich text can express superscript and subscript runs. A shifted run draws on its own baseline within the shared line; when the shift would push its glyph box outside the line box, the line grows to fit it — the same contract inline objects have. `RichText` renders shifted runs at their own baseline and keeps them in their line's projection; the zero-GC buffer path carries the shift in a parallel array so it stays glyph-for-glyph with the allocating path.
