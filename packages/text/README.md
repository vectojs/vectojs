# @vectojs/text

Standalone text-shaping primitives for [VectoJS](https://github.com/vectojs/vectojs).

These are the low-level, renderer-agnostic building blocks that the layout engine
and scene-graph runtime consume. They have no dependency on the scene graph, DOM,
or a renderer, so they can be used on their own (including in workers). Higher-level
text _components_ (`Text`, `RichText`, `Markdown`) live in `@vectojs/ui`; the
`Entity`-based `MSDFTextEntity` / `SVGEntity` stay in `@vectojs/core`.

`@vectojs/core` re-exports everything here for backward compatibility.

## Exports

- `BidiResolver` — Unicode BiDi resolution (wraps `bidi-js`).
- `ArabicShaper` — Arabic contextual glyph shaping.
- `Typography` — CSS-parity line-box / baseline metrics.
- `MSDFFont` — multi-channel signed-distance-field font parsing.
- `PreparedContentGrid` — prepared, shaped content grid for measured text.

## Install

```sh
bun add @vectojs/text
```

## Usage

```ts
import { BidiResolver, prepareContentGrid } from '@vectojs/text';
```
