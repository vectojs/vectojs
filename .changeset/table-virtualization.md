---
"@vectojs/ui": minor
---

Add opt-in virtualization to `Table`. Previously every cell was mounted and every row's chrome was drawn each frame, so a large data table's per-frame cost scaled with the total row count (and a 50k-row table meant 200k live cell entities + their content projections). Passing a `viewportHeight` now fixes the table to that height, pins the header, and scrolls the body — mounting (and projecting a11y for) only the body rows within the viewport plus a small overscan, laid out at a fixed `rowHeight` so scroll↔row-index is O(1). Wheel scrolling uses the same inertial integrator as `Tree`/`VirtualList`, and mounted cells stay fully selectable with correct DOM-vs-canvas geometry.

Omitting `viewportHeight` keeps the classic behavior exactly: the table grows to fit all rows, every cell stays mounted, and rows keep their measured variable heights.

Real-hardware benchmark (`benchmarks/table-virtual`, Chrome 150 + Firefox 153): the virtualized per-frame layout+sync cost stays flat at ~0.3 ms as the table grows, while the classic path grows linearly — at 5000 rows, 41 ms → 0.28 ms on Chrome (149×) and 49 ms → 0.26 ms on Firefox (190×). Text selection on the scrolled, clipped body audits `clean` on both engines.
