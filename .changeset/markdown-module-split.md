---
"@vectojs/markdown": patch
---

Split `Markdown.ts` into six domain modules — `theme`, `markdown-entities`,
`markdown-image`, `markdown-code`, `markdown-math` and `markdown-inline` —
taking the file from 5172 to 3315 lines ahead of the queued syntax work
(footnotes, the image arm, a fenced-block renderer registry), each of which adds
arms to switches inside it.

No public API change: every symbol previously exported from `Markdown.ts` is
re-exported from it, and a new `test/publicApi.test.ts` pins that surface,
including binding identity across the re-export so `instanceof` keeps working.
`MathRender` stays module-private as before.

Two module-level bindings that would otherwise have to be exported across a file
boundary are now encapsulated instead. The three `mathConverter` reads in the
component were pure null-checks and now call the `isMathJaxReady()` that already
returned exactly that, and `inlineMathRasterWaiters` gained subscribe/unsubscribe
functions so the `Set` stays private to the math module.

`mathjax-full` is now referenced from exactly one file, which is what Phase 3 of
the in-house TeX engine has to replace.
