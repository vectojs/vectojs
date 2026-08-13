---
'@vectojs/tex': patch
'@vectojs/markdown': patch
'@vectojs/core': patch
---

P3 review defects from the 2026-08-13 full-repo review (#499, #500).

`@vectojs/tex`: `\llap`/`\clap` ink now lands where CSS puts it (llap ends at the anchor, clap straddles it) instead of all three laps sharing rlap's rightward draw; the emitted viewBox expands to the union of placed ink, so `\smash`/`\hphantom` content and `\llap` ink left of the origin are no longer clipped; and the `color` option (plus `\cancel` strokes and grouped fills) is attribute-escaped before interpolation, hardening the emitter against future user-derived colours.

`@vectojs/markdown`: `inlineMathRasters` is now bounded — a render's raster is dropped when mathCache evicts the render, and the map is capped at the same 256 entries, evicting the least-recently-painted bitmap (re-decoding on the next paint) instead of growing unbounded in long-lived documents.

`@vectojs/core` (WASM kernels): `particle_step` now mirrors the JS oracle's `Math.min`/`Math.max` NaN propagation instead of `f32`'s NaN-ignoring clamps, keeping the differential test bit-identical; `hit_build`/`hit_query` gained an initialized guard so a call-order mistake returns a status instead of trapping the shared instance; and every `*_init` rejects capacities whose `+8` pad or byte size wraps on wasm32 (silent heap-corrupting allocations in release), with `gw * gh` cell arithmetic moved to i64.
