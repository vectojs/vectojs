---
'@vecto-ui/core': minor
---

MSDF hardware-accelerated text and off-main-thread layout.

- **`MSDFFont`**: multi-channel signed-distance-field font model with an O(1) Unicode→glyph lookup, so text stays vector-sharp under arbitrary scale/rotation.
- **`MSDFTextEntity`**: a WebGL render path (median + `fwidth` edge filtering and packed-color unpacking in the shader) with a zero-GC Canvas 2D fallback.
- **`LayoutWorkerManager`**: runs the `LayoutEngine` in a Web Worker (inlined, zero external reference) with leading-edge debounce and deferred Object-URL teardown, so reflow of large documents never blocks the render thread.
