---
"@vectojs/core": minor
"@vectojs/markdown": patch
---

Rebuild the code-block glyph atlas when the device pixel ratio changes, so code
stops blurring after a browser zoom.

`CodeBlock` blits its grid from a shared `GlyphRasterAtlas` whose slots are device
pixels at a fixed ratio. That atlas was a module-level singleton capturing
`devicePixelRatio` at first use, and `GlyphRasterAtlas.dpr` was `private readonly`
with no rebuild path — so after a zoom the grid kept blitting a texture rasterized
at the old ratio while the DPR-scaled context resampled it. Every other text entity
re-rasterizes per frame, so **only code looked soft**, which is why it read as a
font problem rather than a cache problem.

Measured in real Firefox 153 on one live page, no reload: zooming 100% → 133% moved
the renderer 1.579 → 2.068 while the atlas stayed at 1.579 (`blitScale` 1.31,
`resets` 0); at 500% the renderer reached 4.286 for a `blitScale` of 2.71. Peak
edge contrast inside the fenced block fell **171 → 139 → 73** across those three
states while prose held 255.

Atlases are now pooled **per ratio** rather than mutated, since a slot's device
pixels are only meaningful at the ratio they were rasterized at. A zoom selects a
different atlas and zooming back reuses the original instead of re-rasterizing; the
pool is bounded to two entries and `destroy()`s on eviction, because each holds a
2048² canvas (~16 MB). This also makes two scenes at _different_ effective ratios
correct — `SceneOptions.maxDPR` lets one cap at 2 while another runs uncapped, and
a single atlas would have thrashed between them every frame.

The `Math.min(dpr, 3)` cap is gone. It existed because atlas area grows with dpr²,
but it made correctness _impossible_ above it: this host's 500% zoom is 4.286, so a
capped atlas is permanently resampled by 1.43x and no rebuild path helps. A code
block's glyph set is bounded (one mono font, one size, a handful of theme colours),
and the honest failure mode of an over-full atlas is `stats.resets` climbing, which
was already instrumented and already documented as the signal to fall back to
`fillText`. Measured at 4.286 with a real document: 0 resets.

New API, both additive:

- `IRenderer.pixelRatio` (optional, `CanvasRenderer` implements it) — device pixels
  per CSS pixel of the renderer's **backing store**. Read this rather than
  `window.devicePixelRatio` when rasterizing pixels to blit, since the two differ
  whenever a backend clamps. It deliberately reports the ratio the context is
  _currently_ scaled by rather than recomputing live: `devicePixelRatio` changes the
  instant a zoom lands, but the backing store is only reallocated when something
  calls `resize()`, and a live value would hand callers the _future_ ratio during
  that window — the same resampling defect inverted.
- `GlyphRasterAtlas.pixelRatio` — the ratio its slots were rasterized at, so a
  caller can assert `renderer.pixelRatio / atlas.pixelRatio === 1`.

Covered by a new both-engines gate, `packages/markdown/e2e/code-atlas-dpr.e2e.ts`,
which drives three ratios on one live page without reloading and asserts both the
mechanism (`blitScale === 1`) and the symptom (code contrast within 10% of its
first-ratio value, with prose as a control arm). Each arm was confirmed to fail
against the pre-fix behaviour independently — `blitScale` 1.3097, and contrast
178.4 → 147.7 (-17.2%). Peak edge contrast is asserted rather than mean luminance
gradient: mono glyphs are thinner and syntax-coloured, so the mean moved the _wrong
way_ under a 2.71x mismatch (0.216 matched vs 0.251 mismatched) and would have
"disproved" a real defect.
