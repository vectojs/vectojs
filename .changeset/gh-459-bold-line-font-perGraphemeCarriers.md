---
'@vectojs/ui': patch
---

fix(ui): line.font now carries bold/italic for single-style lines (GH-459)

`RichText.visualLineGroups()` built `line.font` with `nodeFont(undefined, largest)`, stripping any bold/italic from the span style. Scene's `perGraphemeCarriers` path sets `mctx.font = lineFont` to measure each grapheme's prefix width, so a bold heading was measured at normal weight — carriers came out too narrow and drifted from the painted glyphs.

Fix: compute `runs` before `font`, then for a single-style line (`runs.length === 1`) use `runs[0].font` which already carries bold/italic/fontFamily from the span's `TextStyle`. Multi-style lines use per-run widths from `logicalRuns()` so `line.font` is only the line-element CSS fallback there and accuracy is less critical.

Regression test added: `selection-fidelity.test.ts` — single-style bold line: `line.font` contains `bold` and `perGraphemeCarriers` is `true`.
