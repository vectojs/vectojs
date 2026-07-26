---
'@vectojs/core': minor
---

Split the WASM animation gate per driver kind, and expose whether it opened.

Spring and tween drivers have measurably different break-even points on the
integrated path: spring and mixed workloads win ~1.4-2.3x from 128 active drivers,
while pure tween is a **0.71x loss** at 128 and only turns net-positive near 256.
One scalar `animDriverGateCount` therefore had to be set for the worse kind, which
discarded the 128-255 spring win to avoid regressing a tween-heavy scene. The two
counts were already tracked separately — only the threshold was shared.

```ts
scene.animGate = { spring: 128, tween: 256, mixed: 128 }; // new defaults
```

A frame with both kinds active uses `mixed`, since the batch is one call per kind
and its economics track the combined count.

`animDriverGateCount` still works: writing it sets all three, reading returns the
tween (conservative) gate.

Adds `Scene.animBatchedLastFrame`, which reports whether the batch path actually
ran. `animBackend === 'wasm'` only means a backend is *installed* — a gate above
the driver count still ticks in JS, and conflating the two makes it easy to believe
an accelerator is active when it never opens.

Firefox remains a net loss at every count measured up to 16384, so these defaults
are Chrome-oriented; on a Firefox-heavy audience leave animation batching off
rather than tuning the gates.
