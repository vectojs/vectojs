---
"@vectojs/animation": patch
---

Make the built-in cubic and back easings (`easeInOutQuad`, `easeOutCubic`, `easeInOutCubic`, `easeOutBack`, `easeInOutBack`) compute integer powers via explicit multiplication instead of `Math.pow`. `Math.pow` is not specified to be correctly rounded and diverges in the last ULP across JS engines; plain IEEE-754 multiplication is deterministic everywhere. This makes easing output identical across V8/SpiderMonkey/JSC and lets the WASM batched-tween kernel (`@vectojs/core`) match `TweenDriver` bit-for-bit rather than to ~1e-9. Visual output is unchanged (differences were sub-ULP).
