---
"@vectojs/markdown": minor
---

Typeset math through `@vectojs/tex` instead of `mathjax-full`, completing Phase 3
of the in-house TeX engine. The `mathjax-full` dependency is removed.

**The math path is 4.06x smaller.** Measured with one bundler invocation
(`bun build --splitting --minify --target=browser`) against a consumer that
imports `Markdown`, before and after, so the delta is attributable to the swap:
the whole bundle goes from 19 chunks / 2 199 869 raw / 748 713 gzip to 3 chunks /
758 249 raw / 273 754 gzip — **63.4% smaller**. Isolating the math path against a
no-math floor (the same consumer with every engine import stubbed, 118 670 gzip)
gives 630 043 gzip for MathJax versus 155 033 for `@vectojs/tex`. A prose-only
consumer's eagerly-downloaded entry chunk is unchanged (118 320 → 117 889 gzip).

No public API change. `MathBlock`, `preloadMathJax` and `isMathJaxReady` keep
their names and behaviour, and `MathRender` stays module-private. The `MathJax` in
those two names is now historical — they mean "the math engine" — kept because
`test/publicApi.test.ts` pins them and renaming would break every consumer for
cosmetics.

The lazy dynamic import stays, though the new engine is fully synchronous.
Bundle size is what motivates it, not engine synchrony: the engine is 84% of the
bundle above, and `renderMathToSVGDataURI` is reachable from the render arm, so a
static import cannot be tree-shaken and a prose-only consumer would pay the whole
engine to render a paragraph. The first formula on a page therefore still renders
as TeX source until the module resolves, and `preloadMathJax()` is still the way
to avoid that.

What the swap removed: six dynamic imports of `mathjax-full`'s CommonJS entry
points, the `interop` helper they needed (esbuild wraps a CJS module and emits
only `export default require_x()`, a defect that typechecked and passed every
unit test before failing in a real browser bundle), and
`convertMathToSVGDataURI`'s regex-scraping of `width="..ex"` and
`vertical-align:-N ex` back out of MathJax's serialized SVG. Geometry now comes
from the layout tree as numbers.

Colour handling changed mechanism but not behaviour. MathJax painted glyphs with
`fill="currentColor"` and needed a `style="color:…"` injected on the root, because
a `data:` URI is an isolated document where `currentColor` falls back to black —
invisible against this package's own dark default theme. `@vectojs/tex` takes a
`color` option and writes it directly, so there is no `currentColor` left to
resolve. Colour remains part of the cache key.

A formula containing a glyph outside the shipped corpus degrades to TeX source in
a `CodeBlock`, the same state an unclosed fence uses. Rendering anyway would show
a formula with a symbol silently absent, which reads as a different equation.

Adds `test/mathBoxGeometry.test.ts` (11 tests), which pins the px box a formula
reserves. Nothing previously read that box — `widthEx`, `heightEx`, `depthEx` and
`exToPx` appeared in no test — so the entire suite passed while the box was
sabotaged five different ways, including a uniform 21% mis-size of every formula.
All five sabotages now fail.
