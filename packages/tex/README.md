# @vectojs/tex

`@vectojs/tex` is the Zero-DOM TeX math typesetting engine of the VectoJS graph: a vendored KaTeX
parse/layout kernel, mechanically stripped of MathML and DOM emission, plus a self-contained SVG
emit layer. It is a leaf package with no dependencies and exists for one constraint: canvas
rasterization goes `data URI -> Image -> createImageBitmap -> drawImage`, so the output must carry
its own glyph outlines and reference no external font or CSS — neither KaTeX's HTML/CSS output nor
any webfont approach can survive that pipeline. `@vectojs/markdown` loads it on demand to typeset
`$...$`, `$$...$$`, and ` ```math ` formulas.

## Install

```bash
bun add @vectojs/tex
```

## Usage

```ts
import { emitSVG, layout } from '@vectojs/tex';

// Parse + lay out TeX into a box tree (strictness violations never throw).
const tree = layout('x^2 + y^2 = z^2', { displayMode: true });

// Emit a self-contained SVG string plus its em-unit metrics.
const { svg, width, height, depth } = emitSVG(tree, { emPx: 16, color: '#e2e8f0' });

console.log(svg.slice(0, 80), width, height, depth);
// svg is a complete <svg> document with glyph paths inline — rasterizable
// through a data URI, safe to hand to an offscreen drawImage.
```

## Highlights

- Vendored KaTeX kernel (`src/kernel/`, MIT): copied from a pinned commit by
  `scripts/vendor-katex.ts` and token-level stripped of MathML/DOM emission so it stays diffable
  against upstream; only the registry files are hand-written.
- Self-contained SVG emit (`emitSVG`): returns `{ svg, width, height, depth }` in em units with
  every glyph outline inlined — no webfonts, no external references, inherits nothing from page CSS.
- Tolerant layout: `layout(tex, { displayMode?, maxSize?, minRuleThickness?, maxExpand? })`
  renders questionable input instead of throwing for strictness violations, matching how a live
  editor needs typesetting to behave.
- Bounded glyph corpus: fonts resolve through `resolveFont` / `shippedFonts`, coverage is queryable
  via `shippedGlyphCount()` and `getGlyph`, and sizing scales through `KATEX_FONT_SCALE` and
  `sizingRatio`.
- Consumer-facing lazy load lives in `@vectojs/markdown`: the engine imports dynamically on the
  first formula (with `preloadMathJax()` / `isMathJaxReady()` controls), keeping prose-only bundles
  at their no-math floor.

> Documents @vectojs/tex@0.1.2.

## Documentation

- [Markdown & math rendering](https://vectojs.org/reference/ui-markdown/)
- [Code blocks](https://vectojs.org/reference/ui-codeblock/)
