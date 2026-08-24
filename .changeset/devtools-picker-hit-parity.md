---
'@vectojs/devtools': patch
---

fix(devtools): picker no longer picks what clicks cannot reach (#671)

`findEntityAt` claimed engine parity but fell back to world-AABB containment
when `isPointInside` declined — production `HitTester.findHitRecursively` has no
such fallback. Particles (`pointerEvents: false`) and rounded/clipped shapes
acquired false owners in the picker, so clicking selected entities the running
app would never resolve at that point, and devtools' own `explainHitTest`
reported "outside shape" for the same coordinate. The fallback is gone: an
entity is pickable only when its own shape accepts the point, exactly like the
engine.
