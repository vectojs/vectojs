---
'@vectojs/ui': minor
---

Add `'center'` and `'right'` to `Text`'s `textAlign` (alongside `'left'` and `'justify'`). Alignment is a post-layout per-line x-offset — `(maxWidth − lineWidth) × {center: ½, right: 1}` — so it needs a `maxWidth` to take effect and keeps the fast one-`fillText`-per-line render path (no glyph-accurate mode). Each aligned line projects a positioned single-run carrier anchored at its offset with its measured extent as width, so DOM selection boxes and find highlights track the shifted glyphs instead of hugging the left edge; wrap-point trailing spaces hang like CSS `text-align`. Offsets are per-line and compose orthogonally with `setVisibleRange` line culling.
