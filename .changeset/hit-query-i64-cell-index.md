---
'@vectojs/core': patch
---

WASM hit-test kernel: `hit_query` now computes its grid cell index in i64 like `hit_build` (#648). On huge viewports or tiny cell sizes the grid dimensions reach `i32::MAX` and the old i32 multiply wrapped — trapping in debug builds and silently reading an unrelated cell in release. Large-grid queries now return a defined miss instead of a wrapped index.
