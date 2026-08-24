---
'@vectojs/core': minor
---

Crates kernel consistency sweep (#662): OOM-to-status contract, shared status vocabulary, SIMD AABB pass.

- **Allocation failure now returns a status instead of aborting.** Every `*_init` in the WASM transform core (`init`, `anim_init`, `hit_init`, `particle_init`, `init_f32`) allocates into a staging store, checks each pointer, and on allocator refusal releases the partial set, publishes the empty store, and returns `STATUS_OVERFLOW`. Previously a failed allocation hit `assert!(!p.is_null())` under `panic = "abort"`, which trapped the whole instance — no JS caller could catch it, defeating the per-call fallback the status design exists for. The JS backend falls back to its reference path on any non-zero status, unchanged.
- **`computeAabbs`/`runAabbs` accept a kernel** (`'simd' | 'scalar'`, default `'simd'`). The new lane-paired `compute_aabbs_simd` is bit-identical to the scalar kernel and to the JS reference: `Math.min`/`Math.max` are exact selection ops over a total order (associative), so pairing entities per `f64x2` lane cannot change output bits — including NaN propagation and ±0, which wasm's `f64x2_min`/`f64x2_max` implement with the same Math semantics. Odd counts take the scalar tail path.
- Fixed a latent readback bug this exposed: `computeAabbs` compared a boolean kernel result against the numeric `WASM_STATUS.OK` and therefore always took the "rejected" branch, skipping every result copy-out. The differential suite now covers both kernels against JS bit-for-bit.

The Barnes-Hut force kernel (`@vectojs/graph3d`) shares the status-vocabulary and checked-arithmetic fixes; see its changeset.
