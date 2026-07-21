# @vectojs/layout

Standalone text/box layout engine for [VectoJS](https://github.com/vectojs/vectojs).

The layout engine turns styled inline runs into positioned lines and glyphs:
line breaking, BiDi-aware inline layout, exclusion (float) flow, glyph
measurement, and an off-main-thread layout worker. It depends only on
`@vectojs/text` for shaping primitives — not on the scene graph or a renderer —
so it can be embedded anywhere text needs to be measured and laid out.

`@vectojs/core` re-exports everything here for backward compatibility.

## Exports

- `LayoutEngine` — the core line-breaking / inline layout engine.
- `LayoutWorkerManager` — drives layout off the main thread via an embedded worker.
- `createCanvasMeasurer` and measurement helpers.

## Install

```sh
bun add @vectojs/layout
```

## Usage

```ts
import { LayoutEngine, createCanvasMeasurer } from '@vectojs/layout';
```

## Build note

The layout worker is bundled to a string (`src/LayoutWorkerSource.ts`) by
`scripts/build-worker.js` before `tsup` runs, so the worker ships inline with no
extra asset. The `@vectojs/text` `MSDFFontData` reference in the worker is
type-only and is erased at bundle time.
