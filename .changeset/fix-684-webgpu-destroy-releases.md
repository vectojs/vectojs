---
'@vectojs/core': patch
---

core: `WebGPUParticleSystemManager` now releases GPU resources (#684). `destroy()` explicitly destroys the compute/render pipelines and both shader modules (previously only nulled, and modules were not even retained), and `setupEntityResources` destroys an entity's previous buffer generation before overwriting it, instead of leaking one buffer pair per re-setup.
