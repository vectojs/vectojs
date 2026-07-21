---
'@vectojs/layout': minor
---

Introduce `@vectojs/layout` as a standalone package: the `LayoutEngine`
(line breaking, BiDi-aware inline layout, exclusion flow), `LayoutWorkerManager`
(off-main-thread layout via an embedded worker), and glyph measurement helpers.
Extracted from `@vectojs/core`; depends only on `@vectojs/text` for shaping
primitives. `@vectojs/core` re-exports everything here (and keeps the
`@vectojs/core/layout` subpath) for backward compatibility.
