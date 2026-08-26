# @vectojs/layout

`@vectojs/layout` is the standalone text/box layout engine of the VectoJS graph: it turns styled
inline runs into positioned lines and glyphs, with line breaking, BiDi-aware inline layout,
exclusion (float) flow, glyph measurement, and an off-main-thread layout worker. It depends only
on `@vectojs/text` for shaping primitives — not on the scene graph or a renderer — and sits below
`@vectojs/core`, which depends on and re-exports it (also reachable as the `@vectojs/core/layout`
subpath).

## Install

```bash
bun add @vectojs/text @vectojs/layout
```

`@vectojs/text` is a runtime dependency and is installed automatically.

## Usage

```ts
import { createCanvasMeasurer, EMPTY_GLYPH_ATLAS, LayoutEngine } from '@vectojs/layout';

// Build a glyph atlas once with a cached offscreen canvas measurer.
const measurer = createCanvasMeasurer('Inter');
const atlas = measurer
  ? { H: { width: measurer.measure('H', 24), baseSize: 24, ast: '' } }
  : EMPTY_GLYPH_ATLAS;

const engine = new LayoutEngine(320, 240, measurer);

// Cold pass: segment + measure (Intl.Segmenter) — the expensive work.
const prepared = engine.prepare('Hello layout world', atlas, 24);

// Hot pass: cheap wrap + position arithmetic; rerun on every resize.
const result = engine.layoutPrepared(prepared);
for (const node of result.nodes) {
  console.log(node.char, node.x, node.y);
}
```

## Highlights

- Cold/hot split: `prepare()` / `prepareRich()` segment and measure once into a reusable
  `PreparedText`; `layoutPrepared()` re-wraps and positions without re-measurement, so resize and
  animation are cheap.
- Paragraph-level memoization makes streaming append paths O(changed paragraph): re-preparing
  growing text (an LLM token stream) only measures new paragraphs.
- Rich text spans: `StyledSpan = { text, style?: TextStyle }` with per-glyph `fontSize`, `color`,
  `bold`, `italic`, `fontFamily`, `lineThrough`, baseline shifts, and `href` links.
- Exclusion flow: `computeLineSegments(top, bottom, maxWidth, exclusions)` computes free line
  intervals around float rectangles in O(n log n), with `layoutPrepared(prepared, mask, exclusions)`
  wrapping text around shapes.
- Zero-allocation hot path: `layoutTextIntoBuffer` / `layoutPreparedIntoBuffer` fill a reusable
  typed-array `LayoutResultBuffer` (capacity 16384 glyphs) carrying per-glyph BiDi levels, reordered
  to visual order per line.
- Off-main-thread layout: `LayoutWorkerManager.getInstance()` queues entity-keyed layouts to an
  embedded worker (`queueLayout` / `cancelLayout`), the engine behind Core's `MSDFTextEntity`.
- Inline objects: reserve boxes inside rich paragraphs via the U+FFFC sentinel with `width`,
  `height`, `depth`, `alt`, and a `paint(surface, box)` callback for icons or math.
- Measurement helpers chain gracefully: `createCanvasMeasurer` (offscreen, cached), DOM-free
  `createMetricsMeasurer`, and `resolveGlyphMeasurer`; DOM-free environments fall back to the
  engine's 0.5em estimate.

> Documents @vectojs/layout@0.10.0.

## Documentation

- [Layout engine reference](https://vectojs.org/reference/core-layout/)
- [Text & Typography guide](https://vectojs.org/learn/text-typography/)
