---
'@vectojs/core': minor
---

Added `SceneOptions.maxDPR` to cap the effective device pixel ratio used to size the Canvas2D and WebGL point-layer backing stores. Backing-store render cost scales with `logical size × dpr²`, so a full-screen HiDPI scene (`pointBackend: 'webgl'` in particular) can overrun its frame budget on a DPR-3 display while running fine on the DPR-1 dev machine it was tuned on — a real jank case measured at 116ms max-frame on a HiDPI display versus flawless 60fps at DPR 1 (findings.md, 2026-07-16). Apps previously had no choice but to monkey-patch `window.devicePixelRatio` before creating the Scene as a workaround (each demo owning its own document made this safe, but it shouldn't have been necessary). `maxDPR` is `undefined` by default (uncapped, real DPR — unchanged behavior from prior versions), and is re-applied on every `Scene.resize()` call (including the automatic window-resize listener), not just at construction, since the real DPR can change at runtime.

`CanvasRenderer` and the WebGL `PointRenderer` interface both gained a public, settable `maxDPR` field (used internally by `Scene`; also usable directly by anyone constructing a `CanvasRenderer` outside a `Scene`). No change to the WebGPU particle canvas path, which already sizes 1:1 to logical width/height with no DPR multiply.
