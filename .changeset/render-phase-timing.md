---
'@vectojs/core': minor
---

Add opt-in per-phase render timing.

A frame total cannot say where the time went, which is the position that produced
two wrong optimisation guesses earlier (a `CodeBlock` reuse and a hit-grid fusion,
both of which measured as no change). `scene.setPhaseTiming(true)` records
`render`, `transform`, `drawWalk`, `entityPaint`, `flush`, `a11ySync` and
`a11yOrder`; read `scene.renderPhases` for totals, averages, worst samples and each
phase's share.

Off by default, and the probes are a single boolean test when disabled — they sit on
the frame path, so the disabled cost has to be nothing.

Nesting is handled explicitly: `render` encloses `transform`/`drawWalk`/`flush`, and
`drawWalk` encloses `entityPaint`, so both enclosing phases report a `null` share
rather than double-counting their children.

First result, on the Markdown streaming workload in both engines: render is
94-99% `drawWalk`, and `drawWalk` is 92-99.6% `entityPaint`. Transform, flush and
a11y sync are each under 0.05%.
