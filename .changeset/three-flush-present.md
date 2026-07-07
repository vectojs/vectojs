---
'@vectojs/three': patch
---

- `ThreeRenderer.flush()` no longer performs a full GL render per call — the Scene flushes around every non-batched node, which made frames O(N²) in entity count. Rendering now happens once per frame in the new `present()` hook (with a microtask fallback for older cores that never call it).
- `stroke()` emits one `THREE.Line` per sub-path instead of concatenating all of them into a single line — no more spurious connector segments across `moveTo()` gaps.
