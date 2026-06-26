---
'@vecto-ui/core': patch
---

Add MSDF (multi-channel signed distance field) GPU text rendering to the WebGL backend.

- `MSDFFont` parses the `msdf-atlas-gen` JSON layout and lays a string out into positioned quads (em→px geometry, atlas→UV with `yOrigin` flip, kerning, `\n`, letter spacing, codepoint-aware).
- `PointRenderer.setMSDFTexture(source, distanceRange)` + `addGlyph(...)` draw those quads as one `TRIANGLES` batch with the Chlumsky median/`fwidth` shader, so glyphs stay crisp at any scale. Kept separate from the `setTexture`/`addSprite` atlas so both can be active.
