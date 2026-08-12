---
'@vectojs/ui': patch
---

fix(ui): per-run positioned carriers for mixed-style RichText (GH-458)

`logicalRuns()` now measures each run's canvas advance at its own font and
returns `{x, width}` alongside `{text, font}`. Scene's positioned-carrier
path (`run.x !== undefined`) then sets `runElement.style.width` to the
canvas-measured value, so the DOM selection box tracks the drawn bold/italic/
link glyphs instead of using the browser's natural-flow width.

Previously mixed-style lines (bold/link spans, `runs.length > 1`) fell through
to natural-flow DOM rendering because `logicalRuns()` returned runs without
`x`/`width`. Per-grapheme carriers (single-style path) were correct; this fixes
the remaining class of selection drift visible on large text with inline bold
or link formatting.
