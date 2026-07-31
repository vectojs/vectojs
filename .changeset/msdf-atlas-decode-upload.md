---
"@vectojs/core": minor
---

Upload an MSDF atlas once it decodes, instead of pinning an empty texture

`WebGLPointRenderer.setMSDFTexture` cached the atlas on source **identity** with
no decode guard. An `HTMLImageElement` handed over while still loading was
uploaded once as a 0×0 texture, recorded as the current source, and never
re-uploaded — so the atlas decoded and nothing sampled it. Layout, hit-testing,
and the accessibility projection were all correct while the text was invisible,
permanently. `MSDFTextEntityOptions.texture` is caller-supplied and there is no
loader helper, so the obvious code hit it every time:

```ts
const atlas = new Image();
atlas.src = "/fonts/inter-msdf.png"; // not awaited
scene.add(new MSDFTextEntity("Hello", { font, texture: atlas }));
```

Both `setMSDFTexture` and `setTexture` now skip a source that has no pixels yet
(`complete`/`naturalWidth` for image-shaped sources, `readyState >= 2` for video)
and, critically, do not record it — so a later frame retries. A decoded-but-empty
raster is treated as not ready too, because a failed fetch also reports
`complete === true`.

Skipping the upload alone would still have left the text blank: the correct
upload has to happen on a later frame, and nothing scheduled one. Measured on
Chromium and Firefox, the scene's own frame loop never uploaded a decoded atlas
in either render mode — `onDemand` skips idle frames, and `always` throttles to
2 FPS when idle, so recovery depended on a throttled tick happening to land after
the decode. `MSDFTextEntity` now subscribes to the atlas's `load` and marks the
scene dirty, releasing the listener in `destroy()`.

Sources with no decode state — a canvas, `ImageBitmap`, or `VideoFrame` atlas —
are unaffected and still upload on first use.
