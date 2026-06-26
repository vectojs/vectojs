---
'@vecto-ui/core': patch
---

Make the core SSR / no-DOM safe (bottleneck: implicit Shadow-DOM dependence).

`Scene` and `CanvasRenderer` no longer hard-require browser globals at construction, so the engine's logic is usable in Node/Bun (headless layout, server-side export) without jsdom:

- `Scene` only builds the a11y/automation shadow layer when `document` exists; otherwise it degrades to a no-op (`a11yRoot = null`, `syncA11y` early-returns). `window` listeners and `requestAnimationFrame` reschedules are guarded too, so construct / tick / `destroy` never throw when those globals are absent.
- `CanvasRenderer` reads `devicePixelRatio` / viewport via guards, falling back to the canvas's own size, and tolerates a null 2D context.
