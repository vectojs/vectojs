---
'@vectojs/core': patch
---

Cut WebGL glyph/sprite/circle batching cost by 3-5x in the per-quad hot loop.

Profiling a 5,000-danmaku scene on real hardware (2560x1600@240Hz, 4.17ms
budget) showed the JS batching loop at 5.4ms/frame against 0.3ms for the actual
GPU submit — an 18x imbalance, at ~24,800 glyphs/frame (222ns/glyph). Two causes,
both fixed with no public API or behaviour change:

- `parseColorToRGBA` promoted every cache hit to most-recently-used via
  `Map.delete` + `Map.set`. Hits no longer promote; eviction is now
  insertion-order (FIFO), which still bounds the map.
- `addGlyph`/`addSprite`/`addCircle` allocated a `corner` closure, a nested
  quad array-of-arrays, and a triangle-order array per quad (~10 temporaries),
  then destructured twice per vertex. Corner maths is now unrolled into a shared
  allocation-free `writeQuad`, with a `rotation === 0` fast path that skips
  sin/cos.

Measured in real browsers on a real GPU (median of 15, accumulate phase only,
`benchmarks/glyph-batch`), at 24,800 glyphs/frame:

| engine  | before | after  | speedup |
| ------- | ------ | ------ | ------- |
| Chrome  | 3.96ms | 1.09ms | 3.7x    |
| Firefox | 6.26ms | 1.34ms | 4.7x    |

Per glyph that is 160ns -> 44ns (Chrome) and 252ns -> 54ns (Firefox). On Firefox
the old path could not fit a 240Hz frame at 24,800 glyphs; it now does.

Vertex output is bit-identical to the previous implementation (verified over
3,000 randomised cases including rotation, maxAbsDiff = 0), and a new test pins
rotated quad geometry, which previously had no coverage.
