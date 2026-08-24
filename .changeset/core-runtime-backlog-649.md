---
'@vectojs/core': patch
---

Clear the core runtime backlog (#649): cycle-safe `add()`, honest accelerator verdicts, mid-walk driver catch-up

- **`Entity.add()` now rejects cycles.** Re-parenting an entity under its own
  descendant (`a.add(b); b.add(a)`) threw no error but overflowed the pre-order
  update/render walks on the next frame; it now throws, matching the DOM's
  `HierarchyRequestError` behavior.
- **Per-kind kernel-rejection verdicts.** When one anim kernel declines a frame,
  `Scene.accelerators.animation.reason` now reports `springs-rejected` or
  `tweens-rejected` (with `activeThisFrame: true`, since the other kind still
  stepped through WASM) instead of the misleading fully-JS `'rejected'`. The
  plain `'rejected'` remains reserved for both kinds declining.
- **Mid-walk driver spawn no longer waits a frame on the batched path.** A
  driver spawned by an earlier sibling's update onto an entity the batch pass
  already claimed was skipped by that entity's per-frame stamp until next
  frame — a one-frame JS/WASM divergence for fixed-step consumers. It is now
  advanced once at spawn with the walking frame's dt.
- **Removed the dead internal helper `Entity._hasActiveDrivers()`** (zero
  callers in the monorepo). Code reaching for it should use the public
  `hasPendingAnimations()`.
- `ComputeParticleEntity.updateCPU` now addresses its particle buffer through
  the published `PARTICLE_STRIDE_FLOATS`/`PARTICLE_OFFSET_*` constants instead
  of hardcoded stride-8 arithmetic, and `getWorldRotation()` documents its
  positive-scale-only contract.

Fixes #649
