---
"@vectojs/text": minor
"@vectojs/layout": minor
"@vectojs/ui": patch
"@vectojs/core": patch
---

Measure text correctly without a DOM

`ARCHITECTURE.md` advertises Node server-side SVG generation and the `Scene`
reference states that in SSR "headless layout / `toSVG()` still work". Layout did
run, but every glyph advance came from a flat `0.5em` guess, because all four
`GlyphMeasurer` factories return `null` without a canvas. Measured against Chrome
at 32px `sans-serif`, widths were wrong by **+125% on narrow text and −47% on
wide** — and `'iiiiiiiiii'` came out byte-identical to `'WWWWWWWWWW'`, since
advances were not proportional at all. Wrapping inherited it, so line breaks
landed in the wrong places too.

`@vectojs/text` now owns a font-metrics registry:

```ts
import { registerMSDFFontMetrics } from "@vectojs/text";

// Only the JSON's advances, kerning, and metrics are read — the atlas image is
// irrelevant, so a metrics-only file works and nothing needs to decode.
registerMSDFFontMetrics("sans-serif", await Bun.file("inter.json").json());
```

Any `msdf-atlas-gen` font works via `registerMSDFFontMetrics`, or supply a
`FontMetricsSource` directly with `registerFontMetrics`. Three measurement paths
consult it, all of which previously had their own hardcoded fallback: per-glyph
advances in `@vectojs/layout`, whole-string widths in `@vectojs/ui` (which size
`Button`, `Input`, `Link`, `Checkbox`, `ContextMenu`, and `ProgressBar`), and the
baseline in `cssLineBoxBaseline`.

**A real Canvas 2D context always wins**, so a browser is unaffected: verified in
Chromium that a deliberately absurd registration changes no measured width by a
single float. Registered metrics replace a fabricated guess; they never
second-guess the engine that will actually draw the text.

New in `@vectojs/layout`: `unmeasuredGlyphCount()` reports how many advances were
fabricated, and a one-time console warning names the fix. This is distinct from
`LayoutResult.fallbackToCanvas`, which only reports an _atlas_ miss and is true on
essentially every paragraph even in a browser.

One documented limit: the per-glyph `GlyphMeasurer` contract is
`measure(char, fontSize, family)`, which has no neighbouring character, so summed
advances cannot recover kerning — measured at ~10% on kern-heavy strings, against
125% before. Whole-string measurement goes through `measureEm` and is exact.
