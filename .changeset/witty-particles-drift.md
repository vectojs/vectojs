---
'@vectojs/core': patch
---

Fixed `ComputeParticleEntity`-based scenes silently dropping to Scene's `renderMode: 'always'` idle auto-throttle (~2fps) whenever nothing else in the tree was animating — despite particles visibly drifting, bouncing, or spring-settling. `ComputeParticleEntity` never overrode `hasPendingAnimations()` (the base `Entity` default is always `false`), so Scene's idle detection had no way to know the particle simulation — which runs through a dedicated pre-pass outside the normal per-entity update walk — was still doing visible work. Any app relying on the particle system's own `markDirty()` calls (fired only from discrete API calls like `setOrigins`/`triggerExplosion`, not per simulation tick) had no ongoing signal once those settled.

`hasPendingAnimations()` now scans live (`life !== 0`) particles for a velocity or origin-offset above a small epsilon (0.5px/s, 0.5px) — large enough that an asymptotically-converging spring+damping system correctly reports "at rest" once it's visually indistinguishable from settled, small enough that genuine motion is never missed. A pending `triggerExplosion()` also counts as pending, since its impulse hasn't been applied to any particle yet at the moment it's requested.
