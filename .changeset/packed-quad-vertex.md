---
"@vectojs/core": minor
---

Pack the WebGL quad vertex, halving the per-frame vertex upload.

Sprite, glyph and circle-quad vertices go from 32 bytes to 16 (position stays
`2xf32`; uv becomes `2xu16`-normalized and tint `4xu8`-normalized), and rect
vertices from 24 bytes to 12. At 50,000 quads that is 6.4 MB/frame down to 3.2 MB,
on top of the 9.6 -> 6.4 MB already banked by the move to indexed quads. The JS
fill shrinks too: `writeQuad` now issues 20 typed-array stores per quad instead of
32, because uv and tint are encoded once and the tint is stored as a single packed
word per vertex.

The shaders are unchanged — `normalized: true` makes the GPU expand the integer
attributes back to floats in `[0,1]` before the vertex shader sees them.

This was deferred from the indexed-quad work because u8 tint alpha quantizes to
256 steps, and vertex alpha carries live animated opacity (colour alpha times
accumulated ancestor opacity times particle life), not a static colour. Measured
before shipping: alpha is a blend factor into an 8-bit framebuffer, so half a u8
step of alpha error moves the composited result by at most half of one framebuffer
step. A 4s fade at 240Hz reaches 256 distinct output levels with a longest
identical-output run of 4 frames under **both** f32 and u8 alpha — the banding in a
slow fade is imposed by the framebuffer, not by the vertex format. Worst
single-layer composited error is 1 of 255 levels, and worst low-alpha overdraw
(alpha 0.02 across 50 coincident layers) is 1.9 levels.

Also fixes a pre-existing bug found while verifying this on a real GPU:
`ensureQuadIndices()` unbound `ELEMENT_ARRAY_BUFFER` after growing the shared quad
index buffer, and it is called from `flush()` with a quad VAO already bound. A VAO
records that binding, so the null was written into the current VAO and permanently
cleared its index binding — every subsequent `drawElements` on it was
`GL_INVALID_OPERATION` and drew nothing. On real hardware this was a fully
transparent framebuffer on both Chrome and Firefox, losing rects in a mixed scene
and glyphs in a text-only one (whichever batch triggered the growth). Neither mock
GL context in the test suite modelled VAO state, so nothing caught it; both now do.

Two behavioural notes:

- Tint RGB is lossless. Colours originate as CSS 0-255 values divided by 255 on
  parse, so they round-trip exactly through u8.
- Tint alpha is now clamped to `[0,1]`. `Entity.opacity` is not range-checked on
  assignment, and an out-of-range accumulated opacity previously reached the
  shader as-is; `alpha > 1` under `SRC_ALPHA` blending is not meaningful, and the
  Canvas2D fallback already ignores out-of-range `globalAlpha` per spec, so this
  brings the two backends closer to agreement.
