---
'@vectojs/core': patch
---

Fix the WASM animation, hit-test, and particle backends silently operating on detached typed-array views after the shared linear memory grows. Every backend of a Scene shares one `WebAssembly.Instance`, so any backend's `*_init` can grow the memory and detach every other backend's views over the old buffer; only the transform backend revalidated them. The anim backend then wrote gathered spring/tween state into a detached buffer (yielding `undefined` reads → NaN entity positions), the hit backend left its grid stale, and the particle backend froze. The three backends now expose `revalidateViews()` (shared `viewsStale` helper) and the anim/hit/particle call sites invoke it after `ensure()`.
