---
'@vectojs/core': patch
---

`WasmTransformBackend.runAabbs` now probes `compute_aabbs_simd` before selecting it.

The published `.wasm` lives at one fixed URL, so a stale cached module can instantiate cleanly yet predate the SIMD AABB export — the default `'simd'` kernel then called the missing export and threw a `TypeError` mid-render. `runAabbs` now downgrades to the bit-identical scalar kernel when the export is absent, keeping the existing `lastStatus`/boolean rejection telemetry unchanged.
