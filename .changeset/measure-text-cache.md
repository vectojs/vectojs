---
'@vecto-ui/ui': patch
---

Memoize `measureText` with a bounded LRU cache (`(font, text) → width`).

Native canvas `measureText` forces a layout/context switch on every call. Hot paths re-measure the same strings each frame — `wrapLines` (per-word candidates) and `Input` caret positioning (growing prefixes) — so a 1000-entry LRU keeps the working set hot while capping memory for dynamic text. Behavior is unchanged; repeated measurements are just served from cache.
