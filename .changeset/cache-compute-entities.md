---
"@vectojs/core": patch
---

Cache the per-frame `ComputeParticleEntity` collection. `Scene.render` walked
the entire tree every frame to gather compute entities — even for the
overwhelmingly common scene that has none, which paid an O(tree) walk per frame
just to build an empty array. The list now rebuilds only on a structural change
(add/remove/reparent, via the existing `_structureVersion`), so a
structurally-stable frame is O(1). Real-HW (`benchmarks/per-frame-walk`, Chrome
150 + Firefox 153): the eliminated walk grew to ~0.27ms/frame at 16k nodes on
both engines. Behavior is unchanged (the gathered set is identical); verified by
a structure-version cache test plus the existing particle/WebGPU suites.
