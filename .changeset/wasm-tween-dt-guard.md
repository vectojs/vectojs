---
'@vectojs/core': patch
---

WASM `tween_step` now declines NaN, zero, and negative `dt` exactly like `TweenDriver.tick` (#784).

One non-positive or NaN `dt` reaching the batched tween kernel used to write `t_elapsed = NaN` through with a success status — poisoning that tween's clock forever in the WASM path (every later comparison false, `isDone()` never true) while pure-JS mode ignored the same step; a negative `dt` additionally rewound finished tweens. The kernel now mirrors the JS guard (`if (!(dtMs > 0)) return;`) before touching any state and reports `STATUS_OK` with nothing written, so both engines decline identically and recover on the next valid frame.

Fixes #784
