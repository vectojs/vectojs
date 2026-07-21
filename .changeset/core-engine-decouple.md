---
'@vectojs/core': minor
---

Decouple the standalone engines out of `@vectojs/core` into their own packages:
`@vectojs/layout`, `@vectojs/text`, `@vectojs/math`, and `@vectojs/animation`.
`@vectojs/core` now depends on and re-exports them, so its barrel and its
`./layout`, `./text`, and `./renderer` subpaths are unchanged — existing imports
keep working with no source changes. This is an internal restructuring for
long-term maintainability; there are no breaking API changes.
