---
"@vectojs/core": minor
---

Warn in dev mode when a Canvas2D style **property** is assigned on a renderer
instead of calling the equivalent method.

`IRenderer` is deliberately method-based — `setGlobalAlpha(alpha)`,
`stroke(color, lineWidth)` — so style travels with the draw call and a batching
or GPU backend has a defined boundary. It has no `globalAlpha`, `strokeStyle`,
`lineWidth`, or `fillStyle` property. Assigning one is not a type error against
a structural interface in untranspiled JS: it attaches an expando, and the draw
silently uses the context default.

Two `@vectojs` demos shipped that way. A bloom-intensity slider moved its halo
luminance by 1.07 instead of 17.0, and a panel rim drew as a black hairline
instead of `rgba(255,255,255,0.25)` at 1.5px — both looked like a dead control
rather than an error.

`CanvasRenderer` and `SVGRenderer` now install dev-mode-only accessors for the
twelve Canvas2D style properties that have no renderer equivalent, each naming
the method to call instead. Warns once per property per instance, so a per-frame
assignment cannot flood the console, and the assigned value still reads back so
a warned write is never a hard break. Nothing is installed outside dev mode.

`Scene.devMode` is now a getter/setter pair rather than a plain field, so
enabling it reaches renderers immediately — including one constructed directly,
without a `Scene`. Assignment is unchanged (`Scene.devMode = true`).

New exports: `installRendererDevTraps`, `setRendererDevMode`,
`isRendererDevMode`.
