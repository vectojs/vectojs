---
"@vectojs/markdown": patch
---

Reuse a streamed blockquote by updating its tail child in place.

A blockquote renders a subtree — an accent border plus one wrapper per inner
block — so unlike paragraph, code, and heading it has no single mutator to call.
Reuse now descends to the last inner block and dispatches to the existing
`setSpans`/`setCode` paths, so a quote streamed line by line no longer destroys
and rebuilds every inner block and its border on each chunk.

The fast path is deliberately narrow: it applies only when the inner block count
is unchanged, every earlier inner block is byte-identical, the tail block kept its
type, and that tail is a `paragraph`, `heading`, or `code`. A nested heading
carries the same depth guard as the top-level path, since `setSpans` cannot change
`font`. Anything else falls back to the existing rebuild, and every rejection path
leaves the entity untouched. Wrapper, inner-stack, border, and container boxes are
propagated by hand so a reused quote stays geometrically identical to a rebuilt
one.

Measured on real hardware (`benchmarks/markdown-stream-phases`, new `blockquote`
shape, two runs per arm): reconcile fell from 52.7/48.8ms to 21.4/23.2ms in Chrome
and 33.0ms to 15.3ms in Firefox. Total append+render time fell 31% (Chrome) and
27% (Firefox) — larger than the heading case, because a rebuild here discarded a
whole subtree.
