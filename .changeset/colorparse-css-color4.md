---
'@vecto-ui/core': patch
---

Fix `parseColorToRGBA` color parsing so the WebGL/sprite backends match Canvas 2D:

- **Percentage alpha** (`rgba(255, 0, 0, 50%)`) now resolves to `0.5` instead of `50`.
- **Modern CSS Color 4 syntax** — whitespace-separated channels with slash alpha (`rgb(255 0 0 / 50%)`, `rgb(0 0 0 / 0.25)`) — now parses directly instead of falling back to a 1×1 canvas (and silently turning black under SSR).
- **Out-of-range values** are clamped to `[0, 1]` (`rgb(300, -5, 0)` → `[1, 0, 0, 1]`), matching how CSS and Canvas 2D treat them, so the GPU path no longer receives `>1` channels.
