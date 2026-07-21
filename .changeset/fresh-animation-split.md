---
'@vectojs/animation': minor
---

Introduce `@vectojs/animation` as a standalone package: the shared `Easing`
library plus `TweenDriver` and `SpringDriver` value drivers. Extracted from
`@vectojs/core`; depends only on `@vectojs/math` for the spring integrator.
`@vectojs/core` re-exports everything here for backward compatibility.
