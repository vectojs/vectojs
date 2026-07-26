---
'@vectojs/core': patch
---

Cut WebGL glyph/sprite batching cost by ~12x in the per-quad hot loop.

Profiling a 5,000-danmaku scene on real hardware (240Hz panel, 4.17ms budget)
showed the JS batching loop at 5.4ms/frame against 0.3ms for the actual GPU
submit — an 18x imbalance, at ~24,800 glyphs/frame (222ns/glyph). Two causes,
both fixed with no public API or behaviour change:

- `parseColorToRGBA` promoted every cache hit to most-recently-used via
  `Map.delete` + `Map.set`. At ~25k lookups/frame that re-ordering cost 11.9ms
  per 24,800 calls vs 0.5ms without it. Hits no longer promote; eviction is now
  insertion-order (FIFO), which still bounds the map.
- `addGlyph`/`addSprite`/`addCircle` allocated a `corner` closure, a nested
  quad array-of-arrays, and a triangle-order array per quad (~10 temporaries,
  ~250k allocations/frame), then destructured twice per vertex. Corner maths is
  now unrolled into a shared allocation-free `writeQuad`, with a `rotation === 0`
  fast path that skips sin/cos.

Vertex output is bit-identical to the previous implementation (verified over
3,000 randomised cases including rotation, maxAbsDiff = 0).
