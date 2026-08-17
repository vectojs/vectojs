---
'@vectojs/graph3d': minor
---

Add an opt-in WASM force kernel: `VectoForceLayout.enableWasmForce()` (plus a `@vectojs/graph3d/wasm` subpath exporting `forceWasmUrl`) runs the Barnes-Hut octree build + repulsion accumulation in a new `crates/vectojs-force-rs` crate, and silently falls back to the bit-identical JS Barnes-Hut on any load/instantiate failure.
