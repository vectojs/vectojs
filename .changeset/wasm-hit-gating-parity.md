---
"@vectojs/core": patch
---

Bring `findEntityAt`'s WASM hit-grid path to parity with the JS walk's clip/opacity/disabled gating (follow-up to the JS-path fix). The WASM path confirmed a grid candidate with `isPointInside` only, so it could still return an invisible (`opacity: 0`) node, a descendant clipped outside a `clipChildren` ancestor, or a `disabled`/`pointerEvents: 'none'` element — diverging from `findHitRecursively`. A shared `isHitEligible(entity, x, y)` gate (walks ancestors for opacity and `clipChildren` containment, plus the pointer-transparency check) now guards both the candidate scan and the boundless-entity pass, so the WASM and JS hit paths return the same entity for every query.
