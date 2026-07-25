---
"@vectojs/core": minor
---

Extend the WASM transform core (G1+) to emit per-node **world-space AABBs**. The transform store now carries optional local render bounds (`bx/by/bw/bh`) and world-AABB outputs (`aminx/aminy/amaxx/amaxy`); a new `compute_aabbs` kernel (plus the `computeAabbsJS` reference + `WasmTransformBackend.computeAabbs` / resident `runAabbs` + `boundsView`/`aabbView`) transforms each node's local box through its already-composed world matrix and reduces the four corners to a min/max AABB. This is what viewport culling currently recomputes per visible node each frame (a 4-corner f64 transform in `Entity.getWorldBounds`), and what G3's hit-grid build wants to read directly from the resident matrices.

The pass is **bit-identical** to `Entity.getWorldBounds`/`computeAabbsJS` — same corner-selection, same op order, and it matches `Math.min`/`Math.max` NaN/±0 semantics exactly (Rust `js_min`/`js_max` propagate NaN, unlike `f64::min/max`), so even a pathological transform whose scale overflows to Infinity agrees between engines. Verified across flat/chain/bushy/mixed topologies up to 100k nodes.

Real-hardware benchmark (`benchmarks/core-wasm`, resident WASM vs the JS 4-corner pass): ~2.7–4.2× on Chrome 150 (its JIT leaves the JS loop at ~56–64 ns/entity; WASM is a steady ~15 ns), and roughly at parity on Firefox 153 (~0.9–1.3×, since its JIT already compiles the JS pass to the same ~15 ns). Never a regression; the JS path remains the permanent fallback. Not yet wired into the render walk — that integration is a separate gated step.
