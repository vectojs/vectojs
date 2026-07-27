---
'@vectojs/core': patch
---

Document that `Scene.step()` renders unconditionally — it consults neither
`renderMode` nor `dirty` and skips the idle auto-throttle. Callers measuring
frame scheduling must drive `start()` instead; `step()` cannot observe frame
skipping, so `always` and `onDemand` report identical draw counts through it.
