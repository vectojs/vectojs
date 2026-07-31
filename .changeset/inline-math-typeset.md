---
'@vectojs/markdown': minor
---

Typeset inline `$...$` math instead of showing its TeX source.

Inline math previously rendered as gold (`#fcd34d`) source text with the `$`
delimiters visible, because `collectSpans` pushed `token.raw` and never called
MathJax — `ensureMathJax()` was only reached from the fenced-block arm, so a
document whose only math was inline never even started the lazy load. It now
reserves a real inline box via `StyledSpan.object` (added in `@vectojs/layout`
1.1.0), carrying the TeX source as the box's accessible name.

Also fixes a pre-existing mis-sizing of **block** math. The `ex`-to-px
conversion was a hardcoded `ex * 8`, which is exact only near a 18.1px font
size — so a block formula was ~13% oversized at this package's own 16px
default, +51% at 12px, and −43% at 32px. It is now
`ex * fontSize * 0.4421`, resolved against the size of the run the formula
actually sits in, so `$x$` in a heading scales with the heading.
