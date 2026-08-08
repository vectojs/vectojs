---
"@vectojs/core": patch
---

fix(core): release the WebGPU device when a scene is destroyed mid-initialization

The first-frame WebGPU init handler assigned `this.device`, cleared
`initializingWebGPU`, constructed the particle manager and called
`initPipelines` — all without checking `destroyed`. A `destroy()` landing while
`initWebGPUContext`'s promise was still pending therefore created the device
_after_ teardown and never released it: one leaked GPU device per occurrence,
plus a manager and its pipelines built against a scene that no longer exists.

The handler now mirrors the guard the context-recovery path has always had, and
calls `newDevice.destroy()` before returning — a bare early return would leak the
same device in a less visible shape, since the device is created by the time the
handler runs either way. `initializingWebGPU` is also cleared so the field does
not advertise an init that is no longer in flight.

Only the first-frame init site was affected; the recovery retry already had the
check and is unchanged.

Unit tests: `packages/core/test/SceneWebGPU.test.ts` drives a `requestDevice()`
that stays pending until the test resolves it, so `destroy()` runs strictly
inside the race window. Verified fail-old — without the guard the device is
adopted and its pipelines are built on the destroyed scene.
