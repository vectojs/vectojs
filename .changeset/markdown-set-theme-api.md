---
'@vectojs/markdown': patch
---

Add `Markdown.setTheme(theme)` and keep `theme` read-only (#776)

`Markdown.theme` is a getter over internal state (PR #776), so the one
in-repo consumer that still assigned to it (`MarkdownApp.setTheme`) failed
to compile. `setTheme` accepts a preset name or a partial theme — the same
shapes as the constructor option — swaps the palette and re-renders through
`setContent`, carrying the new `blockGap` onto the content stack. Direct
assignment stays a compile-time error and now also throws at runtime for JS
callers.

Refs #776, #657
