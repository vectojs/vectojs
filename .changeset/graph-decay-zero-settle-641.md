---
'@vectojs/graph-layout': patch
'@vectojs/graph3d': patch
---

Reject degenerate force-layout options that silently hung or froze simulations (#641).

- **`alphaDecay: 0` no longer passes validation in `ForceLayout2D`.** The per-tick decay `alpha += (0 - alpha) * alphaDecay` became a no-op, `step()`'s `alpha >= alphaMin` guard stayed true forever, and hosts driving `while (layout.step()) requestAnimationFrame(loop)` never stopped — silent permanent CPU/GPU burn with no error. A non-positive decay now falls back to the default 0.0228.
- **`repulsionDistanceMax: 0` no longer silently disables repulsion in `ForceLayout2D`.** A finite cutoff of 0 hit the force kernel's `maxDistance <= 0` early-return, switching repulsion off entirely while the types only documented "non-finite disables the cutoff". Any non-positive cutoff now means the same as `Infinity` (no cutoff).
- **`VectoForceLayout` mirrors the decay guard.** It took `alphaDecay` raw with no validation at all; a literal 0 there had the same never-settles failure mode.
