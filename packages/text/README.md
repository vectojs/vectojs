# @vectojs/text

`@vectojs/text` is a leaf package of the VectoJS graph: renderer-agnostic, DOM-free text-shaping
primitives — Unicode BiDi resolution, Arabic contextual shaping, CSS-parity typography metrics,
MSDF font parsing, and prepared content grids. It has no dependency on the scene graph or a
renderer (only `bidi-js`), so it runs anywhere, including in workers; `@vectojs/layout` builds its
line breaking on it and `@vectojs/core` re-exports everything here for backward compatibility.

## Install

```bash
bun add @vectojs/text
```

## Usage

```ts
import { ArabicShaper, BidiResolver, cssLineBoxBaseline } from '@vectojs/text';

const mixed = 'Hello \u0645\u0631\u062D\u0628\u0627 world';

// Visual order for rendering: logical index -> visual position.
const order = BidiResolver.reorderIndices(mixed);
console.log(order.map((i) => mixed[i]).join(''));

// Contextual Arabic glyph forms with source-index traceability.
const shaped = ArabicShaper.shapeArabic('\u0645\u0631\u062D\u0628\u0627');
console.log(shaped.shapedText, shaped.indexMap);

// CSS-parity baseline placement without touching the DOM.
const baseline = cssLineBoxBaseline('400 16px Inter', 24);
```

## Highlights

- `BidiResolver` — Unicode BiDi embedding levels, visual reordering, and logical-to-visual run
  splitting (`resolveLevels`, `reorderIndices`, `logicalToVisualRuns`, `getBaseLevel`) on top of
  the battle-tested `bidi-js` tables.
- `ArabicShaper` — contextual glyph shaping into initial/medial/final/isolated forms with
  `ShapedResult.indexMap` preserving the mapping back to logical characters.
- `prepareContentGrid()` / `PreparedContentGrid` — an immutable per-cell plan retaining UTF-16
  source ranges, legal grapheme carets, CR/LF ownership, tab stops, wide CJK/emoji advances,
  Arabic shaping, and bidi positions; the geometry shared by canvas paint and browser-native
  selection in Core's content projection.
- `MSDFFont` — parses the de-facto `msdf-atlas-gen` JSON (`MSDFFont.parse`) and lays text into
  CSS-pixel quads with atlas UVs honoring newlines, kerning, and letter spacing, ready for the
  WebGL MSDF path behind `@vectojs/core`'s `MSDFTextEntity`.
- Font metrics registry: `registerFontMetrics` / `registerMSDFFontMetrics` /
  `createMSDFMetricsSource` supply DOM-free ascent/descent data, and
  `cssLineBoxBaseline(font, lineHeight)` returns CSS-parity baselines with an LRU cache.
- Shared offscreen measuring context helpers (`getSharedMeasuringContext`,
  `createMeasuringContext`, `resetSharedMeasuringContext`) keep measurement cheap and detach-safe.
- Zero DOM usage throughout — every export is callable from a Web Worker.

> Documents @vectojs/text@0.4.2.

## Documentation

- [Text & Bidi reference](https://vectojs.org/reference/core-text/)
- [Text & Typography guide](https://vectojs.org/learn/text-typography/)
