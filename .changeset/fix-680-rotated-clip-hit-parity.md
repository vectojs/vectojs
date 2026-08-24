---
'@vectojs/core': patch
---

core: both hit-test paths now clip against a `clipChildren` ancestor's exact (rotation-aware) local rect (#680). The JS recursive walk previously clipped to the ancestor's world AABB while the WASM flat gate tested the exact local rect, so a point in the AABB corner of a rotated clip container resolved differently depending on which backend was active. A shared `isInsideAllClippers` gate is now authoritative on both paths, with a differential fixture covering rotated clippers. Zero-size clip containers now consistently reject descendants instead of being skipped by the WASM gate.
