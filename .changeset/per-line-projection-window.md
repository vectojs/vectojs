---
"@vectojs/core": minor
"@vectojs/ui": minor
"@vectojs/markdown": minor
---

Virtualize content projection per line inside one tall entity.

`contentProjectionMargin` gates whole entities, which frees blocks that scroll
away but cannot help an entity _taller_ than the viewport: its box always
intersects, so every one of its visual lines was materialized — a `<span>` per
line, and on the grid path a `<span>` per glyph cluster. That is the origin of the
"14.8k elements for a 346KB Markdown document" already documented in `Scene`, and
it made per-frame projection cost scale with the document instead of the viewport.

`Scene` now materializes only the contiguous run of lines near the viewport, and
passes that band to `Entity.getContentProjection(hint?)` so an entity whose
projection build is O(glyphs) can make it O(visible glyphs). `Text`, `RichText`
and `CodeBlock` honour the hint.

Measured on one entity scrolled to its middle, real headed browsers, 4000 lines:

|              | before        | after           |
| ------------ | ------------- | --------------- |
| Chrome       | 4.21 ms/frame | 0.20 ms (21.1x) |
| Firefox      | 4.83 ms/frame | 0.14 ms (34.5x) |
| DOM children | 36,000        | 1,026 (35x)     |

The gated cost is flat across a 20x document-size range, so this converts an
asymptote rather than shaving a constant.

`ContentProjectionHint` is additive and advisory: ignoring it stays correct
because the Scene windows the DOM regardless, so existing `getContentProjection`
overrides keep working unchanged. The window is deliberately contiguous — a gap
would let a drag across it silently omit the lines in between — and never empty,
because text missing from the projection is invisible to find-in-page, copy and,
for static text, the screen reader.
