---
"@vectojs/markdown": minor
---

Load MathJax on demand instead of at module scope.

The six `mathjax-full` imports and the MathJax document construction were
top-level, so every consumer paid them whether or not any document contained a
formula. Measured on a browser bundle of a consumer that imports `Markdown` and
renders only prose: **2,157,295 bytes raw / 725,012 gzipped, down to 339,767 /
106,095** — MathJax was 85% of the bundle. Startup also drops roughly 150 ms of
module evaluation. Realising the size win requires code splitting in the
consumer's bundler.

New exports `preloadMathJax()` and `isMathJaxReady()`.

**Behaviour change:** the first formula on a page can no longer be typeset
synchronously. It renders as a code block of its TeX source — the state an
unclosed fence already used — and is replaced when the module resolves; later
formulas are synchronous. While streaming this is hidden by prefetching on the
opening fence, and `await close()` / `onStable` now wait for a pending load so a
final document is never handed an untypeset formula. Call `await preloadMathJax()`
before constructing to keep the first formula synchronous.
