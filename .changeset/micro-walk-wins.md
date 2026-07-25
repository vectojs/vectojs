---
"@vectojs/ui": patch
"@vectojs/core": patch
---

Two measured per-frame wins from the micro-walk survey (the rest of that list was
measured and found not to be hotspots — see below):

- **`measureText` shaped before checking its own cache** (`@vectojs/ui`). The LRU
  was keyed on the _shaped_ text, so every cache **hit** still ran
  `ArabicShaper.shapeArabic()` first — measured at ~60% of the whole hit cost
  (49.7ms of 83ms per 20k hits), and pure overhead for the ASCII majority where
  shaping returns the input unchanged yet still allocates an index map. The key is
  now the raw text and shaping happens only on a miss: **4.14µs → 0.34µs per hit
  (12×)**. Arabic is still measured in its contextually-shaped form — the change
  affects only _when_ shaping runs.
- **`syncOverlayGeometry` re-wrote every overlay style every frame**
  (`@vectojs/core`). It assigned ten style properties per overlay layer on every
  synced frame even when the canvas box, logical size, and CSS↔logical scale were
  all unchanged — the normal case, since those only move on resize, zoom, or an
  ancestor scroll. It now memoizes the geometry it last wrote and returns early
  when nothing moved; the memo is invalidated when a WebGL/WebGPU layer is created
  lazily, so a brand-new layer is still positioned.

Measured and **not** changed, to save the next person the investigation: the
`scene` getter's parent-chain walk (`Entity.ts`) costs 0.14µs per read at depth 50
(28.4ms per 200k reads) — caching it would add reparenting/attach invalidation
complexity for no measurable gain.
