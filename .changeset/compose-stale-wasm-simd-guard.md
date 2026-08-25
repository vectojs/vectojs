---
'@vectojs/core': patch
---

`WasmTransformBackend.compose` and `.runKernel` now probe `compose_simd` before selecting it.

The published `.wasm` lives at one fixed URL, so a stale cached module can instantiate cleanly yet predate the SIMD compose export — the default `'simd'` kernel then called the missing export and threw a `TypeError` mid-render (the same gap #798 closed for `compute_aabbs_simd`, and `runKernel` is the designed per-frame hot path). Both entry points now downgrade to the bit-identical scalar kernel when the export is absent, keeping the existing `lastStatus`/rejection telemetry and compose's skip-readback semantics unchanged.
