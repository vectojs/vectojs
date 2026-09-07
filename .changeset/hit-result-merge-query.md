---
'@vectojs/core': minor
---

Add the `HitResult` merge query API (RFC5 §2, step 1): `Scene.findHitsAt` / `Scene.findHitsAtClient` merge the canvas spatial test with caller-observed DOM-native candidates (`mirror` / `portal` / `dom-visual` extension point) into one ordered candidate list with `{ node, backend, localPoint, worldPoint, priority }`. Overlay order is authoritative and the same `disabled` / `pointerEvents: 'none'` predicate gates both sides. Query only — `findEntityAt`, dispatch, and keyboard/AT flows are unchanged.
