---
'@vectojs/tex': patch
---

Drift guards and edge-case fixes in the TeX emit layer (issue #611).

`bun run vendor --check` now also verifies the constants `src/emit/`
hand-transcribes from files it does not vendor: `$mu`, `$nulldelimiterspace`,
both size-multiplier tables (`katex.scss $sizes` and `Options.ts
sizeMultipliers`), the `.katex` default font shorthand, the class-to-face font
tables, and the vlist row-alignment classes. A new SCSS flattener re-derives
each value from the upstream checkout on every vendor run in either mode, so a
stylesheet change fails the run with a message naming both sides instead of
shipping misplaced rules, delimiters or script sizes.

`defineEnvironment` now passes through `argTypes`, `allowedInText` and
`numOptionalArgs` (with upstream's documented defaults) instead of pinning them,
so a future KaTeX bump that starts declaring these fields surfaces them in
`_environments` rather than dropping them silently.

Two glyph edge cases: a missing glyph whose font metrics are also missing no
longer advances the pen by a non-finite width (which poisoned penX and the whole
viewBox) — it degrades to zero advance with a once-per-glyph warning — and the
glyph table's negative cache is bounded (FIFO, 1024 entries), so adversarial
codepoints cannot grow memory unboundedly in long-lived SSR.
