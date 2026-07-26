---
'@vectojs/core': patch
---

Re-acquire WASM typed-array views when a shared instance grows its memory.

Sharing one instance per Scene means all four backends share one linear memory, so
one backend's allocation can grow it and **detach every view built over the old
buffer**. A detached `Float64Array` reports length 0 and returns `undefined` for
every index, so the transform store silently appeared empty instead of failing.

Verified directly against the binary: after `init(100000, …)` the world-matrix view
is length 100008; after a subsequent `hit_init(…)` it is 0.

`WasmTransformBackend.revalidateViews()` rebuilds the views when the buffer they
were built over is gone, and the Scene calls it before writing transform inputs,
before uploading local bounds, and before reading world AABBs. Without it, a Scene
that enabled transforms *and* hit-test would write every per-frame transform into a
dead buffer.

Also adds the fused hit-grid gather: with the transform store resident, the grid
build reads world AABBs out of WASM memory instead of re-deriving four transformed
corners per entity in JS. Measured on real hardware it is a **modest** 1.07-1.09x
on Chrome and neutral-to-slightly-negative on Firefox — it does *not* fix the cold
hit-test path, whose cost is the JS pre-order walk and the grid build, not the
corner arithmetic. `Scene.hitGatherPath` reports which gather ran.
