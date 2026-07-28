---
'@vectojs/core': minor
'@vectojs/devtools': minor
---

Report per-frame accelerator status, and stop rendering stale world matrices.

`Scene.accelerators` returns `{ transform, animation, hitTest, particle }`, each
`{ available, activeThisFrame, reason, path }`. The existing getters
(`transformBackend`, `animBackend`, `hitTestBackend`, `particleBackend`) report
only that a backend is INSTALLED, so a scene holding four WASM backends and
running every frame in JS described itself as fully accelerated. `reason` is a
named union — `'active' | 'not-installed' | 'below-gate' | 'rejected' |
'not-applicable'` — that separates a tuning outcome (`'below-gate'`, working as
designed) from a fault (`'rejected'`, the kernel refused its own arguments).

`@vectojs/devtools` gains `inspectAccelerators`, `auditAccelerators`,
`formatAcceleratorInspection`, and the `acceleratorInspector`/`acceleratorAudit`
plugins, from the headless entry as well as the panel. The audit fires only on
`'rejected'`: warning about a gate that is working correctly would train readers
to ignore it.

Fixes a stale-render bug found while wiring this up. `Scene._syncWasmStore`
discarded `runKernel`'s status and returned the world-matrix views regardless, so
a rejected kernel — which writes nothing — left the previous frame's matrices in
place and the render walk consumed them as current. The batch `compose()` path
already guarded against exactly this; the resident per-frame path did not. It now
returns `null`, routing that frame through JS composition. `uploadRuns` likewise
returns a boolean rather than silently leaving the previous topology published,
and `ComputeParticleEntity.stepWithBackend` returns whether the kernel ran so the
Scene can report which path actually simulated the frame.
