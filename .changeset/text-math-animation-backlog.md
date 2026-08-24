---
'@vectojs/animation': patch
'@vectojs/math': patch
'@vectojs/text': patch
---

Backlog hardening for text/math/animation (#652): `TweenDriver.tick` ignores NaN/negative dt instead of poisoning the elapsed clock; `isTweenConfig(null)` returns false; `SpringPhysics` validates stiffness/damping/target and the initial value (throw at mutation, matching `mass`); `MSDFFont.layout` treats `\r\n` and lone `\r` as line breaks with no phantom CR advance; the typography baseline cache is LRU-bounded at 512 entries; documented `SpatialHashGrid.query` full-grid fallback semantics and settled public-API status of `createMSDFMetricsSource`/`hasFontMetrics`/`isSharedMeasuringContextAttached`.
