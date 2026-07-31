---
"@vectojs/layout": minor
"@vectojs/ui": minor
"@vectojs/markdown": patch
---

Paint inline objects, and cover inline math in the real-browser e2e

`InlineObject` gains an optional `paint(surface, box)` callback, invoked by
`RichText` once per render at the box the layout engine reserved. Two supporting
types are exported: `InlineObjectBox` (the resolved position, with `y` already
offset for the object's `depth`) and `InlineObjectSurface` (the two `drawImage`
overloads a painter needs — structurally a subset of `IRenderer`, declared in
`@vectojs/layout` because that package sits below `@vectojs/core`).

This fixes inline `$...$` math, which reserved its box correctly and then left it
empty: the engine does not draw objects, and the span carried the formula's
dimensions but not its raster. A correctly measured, positioned, and accessible
formula rendered as a blank gap.

The `@vectojs/markdown` change is a `patch` because it restores intended
behaviour rather than adding API. It supplies a painter that draws the typeset
SVG, decoding it once per formula into a module-level raster cache and
repainting when it lands.

`packages/markdown/e2e/lazy-math.e2e.ts` now covers inline math, including a
pixel sample inside the reserved box. That assertion is the only one that can
see this class of bug: no unit-test environment can: Bun has no `globalThis.Image`,
and jsdom has one that never settles a `data:` URI.
