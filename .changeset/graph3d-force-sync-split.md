---
'@vectojs/graph3d': minor
---

Split the WASM opt-in on `VectoForceLayout` into `enableWasmForce(url | Response)` (streaming, browser) and `enableWasmForceSync(bytes)` (Node/tests), so raw bytes are compiled directly and can never reach the fetch path.
