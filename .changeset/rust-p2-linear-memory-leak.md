---
'@vectojs/core': patch
---

Free the previous SoA allocation when a WASM backend re-inits in place on capacity growth.

The transform, anim, hit, and particle backends all re-init their store in place when the scene grows (`backend.ts::ensure` and the anim/hit/particle equivalents), but the Rust `*_init` exports leaked their previous arrays with no `dealloc` anywhere — the crate's original assumption was that a growing scene re-instantiates the module. Each growth leaked 21 f64 arrays for the transform store (plus 13/8/7 for anim/hit/particle), and because dlmalloc never saw the old pointers, wasm linear memory grew monotonically for the lifetime of the instance.

`init`, `anim_init`, `hit_init`, and `particle_init` now free the previous allocation (recovering the exact size and 16-byte alignment from the capacities they already record) before overwriting the pointers, so a same-capacity re-init no longer grows `WebAssembly.Memory` and a growth enlarges it once.
