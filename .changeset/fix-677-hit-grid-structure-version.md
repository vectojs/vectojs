---
'@vectojs/core': patch
---

core: the WASM hit-grid reuse gate now keys on structure version in addition to frame number (#677). A pointer query in the same frame as a structural mutation (add/remove) previously resolved against the stale pre-mutation grid while the JS walk saw live state.
