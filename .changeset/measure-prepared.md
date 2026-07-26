---
'@vectojs/layout': minor
---

Add `LayoutEngine.measurePrepared(prepared)` — line count + total height at the
engine's current `maxWidth` without positioning a single glyph or allocating a
`LayoutNode`.

`layoutPrepared()` exists to produce positioned glyphs, because selection
geometry and the a11y projection need them. But a caller that only wants "how
tall is this at this width" — a virtualized list measuring rows, a resize pass,
an autosizing container — was paying the full O(glyphs) walk plus one allocation
per glyph for data it discards. `measurePrepared()` walks the prepared *word*
widths instead (O(words), zero allocation), reusing the same greedy wrap
decisions, and falls back to per-glyph stepping only for a word wider than the
measure (which must break mid-word).

Measured real-HW (Chrome 150 / Firefox 153, 500 prose blocks × 4 widths):
**30.71ms → 0.92ms (33×) in Chrome, 25.38ms → 4.02ms (6×) in Firefox.**

Found by benchmarking against `@chenglou/pretext`, whose hot path is
segment-level for exactly this reason — see the new `comparisons/` directory.
