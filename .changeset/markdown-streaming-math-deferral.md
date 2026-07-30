---
"@vectojs/markdown": patch
---

Defer TeX math conversion until the fence closes, and cache converted formulas.

`marked` lexes an unterminated fenced block as a complete `code` token as soon as
it reads the info string, so a math formula streamed a few characters at a time
arrived as a long run of whole tokens — nearly all of them syntactically invalid
TeX. Every one of them ran MathJax, the most expensive call in this package, and
each result was an error glyph immediately replaced by the next chunk.

A math fence now renders as an ordinary `CodeBlock` showing the TeX source while
it is open, and typesets on the chunk that closes it. As a `CodeBlock` it also
picks up the existing `setCode` in-place update, so the growing source costs one
mutator call per chunk instead of an entity rebuild.

Converted formulas are additionally memoized in a bounded process-wide cache, so a
repeated formula converts once — including the common case of a closed fence whose
`raw` grows by the newline that follows it.

Measured on the new `math` shape of `benchmarks/markdown-stream-phases` (a formula
streamed in six chunks, a fresh formula per cycle so the cache cannot flatter the
result), median of 7 trials, two runs per arm on real hardware:

| Engine  |       reconcile |            total |
| ------- | --------------: | ---------------: |
| Chrome  | 77.0ms → 12.8ms | 158.5ms → 85.2ms |
| Firefox | 91.5ms → 11.9ms | 173.3ms → 88.8ms |

MathJax invocations over 36 streamed chunks containing three distinct formulas
drop from 18 to 3.

Also fixes a latent bug on the same path: the formula `Image` decodes its SVG
asynchronously and had no `onLoad` handler, so under an `onDemand` scene — which
repaints only when marked dirty — a formula could stay a blank placeholder
indefinitely.
