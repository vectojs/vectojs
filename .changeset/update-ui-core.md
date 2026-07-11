---
'@vectojs/core': minor
'@vectojs/ui': minor
---

- Fix massive memory leak in `Entity.remove()` causing A11y DOM nodes to orphan and leak memory.
- Upgrade `Table` to support `Entity` children allowing for inline Markdown styling inside cells.
- Fix `MarkdownView` FPS drops during streaming by dynamically throttling AST evaluations.
