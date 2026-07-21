---
'@vectojs/ui': major
---

**Breaking:** `Markdown` and `CodeBlock` have moved to the new `@vectojs/markdown`
package. `@vectojs/ui` no longer exports them and no longer depends on `marked`
or `mathjax-full`, so apps that don't render Markdown no longer pull in those
heavy dependencies.

Migration: `import { Markdown, CodeBlock } from '@vectojs/ui'` →
`import { Markdown, CodeBlock } from '@vectojs/markdown'` (add the
`@vectojs/markdown` dependency). Everything else in `@vectojs/ui` is unchanged.
