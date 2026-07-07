---
'@vectojs/core': patch
---

Fix animation/runtime latent bugs found in the 2026-07-06 full-source review:

- `SpringPhysics` now integrates in clamped substeps — a background-tab rAF gap (multi-second dt) no longer catapults spring-animated entities off-screen.
- `Scene` onDemand frame skipping no longer silently disables itself when `autoThrottle: false` is set.
- Layout worker: multi-line text now reports the widest line's width (was: last line), wraps whole words (with per-glyph breaking for CJK/long words), honors `\n`, and swallows the wrapping space; glyph advance lookup is now O(1).
- WebGL point layer: identical texture sources are no longer re-uploaded every frame; switching MSDF atlases mid-frame commits the pending glyph batch first (two fonts no longer render with one atlas); the GL canvas now composites with `premultipliedAlpha: false` matching its straight-alpha blending (no more bright AA fringes).
- `MSDFTextEntity` GL path now honors ancestor opacity.
- `SplineEntity` gradient documents bypass the bitmap cache (gradients rendered as `defaultColor` before) and solid-color bakes are DPR-scaled (no more blurry cached splines on HiDPI).
- `colorParse` clears its shared 1×1 canvas before each fallback parse (semi-transparent named/hsl colors no longer blend with the previous parse).
- Legacy `Entity.animate()` writes past the property setters, so it no longer spawns/retargets transition drivers every frame when `setTransition` is configured on the same property.
- `Scene.destroy()` releases the WebGPU device; `Scene.resize()` resizes the WebGPU particle canvas; removing the last `ComputeParticleEntity` clears the GPU canvas instead of freezing the final frame.
- Embedded scenes (`disableWindowResize`) keep the canvas's own dimensions — `CanvasRenderer` no longer clobbers them to the window size.
- New optional `IRenderer.present()` hook: `Scene` calls it once at the end of each render pass so retained-scene backends can do their single real GL render there.
