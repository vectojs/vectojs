---
'@vectojs/core': patch
---

WASM tween kernel now mirrors `TweenDriver`'s terminal snap (#647): once a tween completes, `tween_step` writes the destination value exactly instead of `from + (to - from) * ease(1)`, which rounds short of `to` for magnitude-spread pairs (e.g. `1e20 → 7`). WASM-advanced tweens now land bit-for-bit on the JS reference's final value.
