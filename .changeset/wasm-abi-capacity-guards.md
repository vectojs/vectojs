---
'@vectojs/core': minor
---

Validate counts on every raw WASM ABI export instead of trusting the caller.

The anim and particle kernels took a `count` from JS and walked their SoA arrays
with it unchecked. `anim.rs` tracked no capacity at all, and `particle_init`
accepted a `capacity` argument it discarded, so their Safety contracts were
unenforceable even in principle — there was nothing to compare against. A stale
or oversized count read and wrote past the allocation; the sandbox contains that,
but it can still trap, corrupt the module's own linear memory, or return wrong
data and break a frame.

`spring_step` and `tween_step` now return a status (previously `void`) and reject
an over-capacity or pre-`anim_init` call without writing. `particle_step` returns
its rejection as a NEGATIVE status, because both `0` and `1` are meaningful
successes for its fused pending-animation flag.

`ParticleBackend.step` therefore returns `boolean | null`, `null` meaning the
kernel declined; `AnimBackend.stepSprings`/`stepTweens` and
`TransformBackend.runAabbs` return a `boolean`. All three expose `lastStatus`.

Also fixes three places where a status was already available but discarded:
`compute_aabbs` was typed `void` in TS despite returning one, so a rejected AABB
pass published the previous frame's world bounds as current; `Scene`'s WASM AABB
gather marked them fresh regardless; and a rejected particle step would have
scattered the pre-step gather buffer straight back, freezing the simulation while
still looking like a successful frame. Each now falls back to its JS path.
