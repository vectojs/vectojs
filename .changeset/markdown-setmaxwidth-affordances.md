---
'@vectojs/markdown': patch
---

Fixes #701: `setMaxWidth` no longer no-ops code blocks and tables under `blockAffordances: true`. Those blocks arrive wrapped in `BlockWithAffordances`, whose own box is assigned once at construction, so the reflow arms' direct `instanceof CodeBlock`/`instanceof Table` tests failed and every rewidth silently kept the old width while prose rewrapped. The reflow now looks through the wrapper, resizes the inner block, and calls `refreshAffordances()` so its controls track the new right edge.
