---
'@vectojs/ui': minor
---

Extract the blockquote overlay's anonymous non-layouting `Entity` subclass into a named, reusable `MarkdownContainer`, and use it to wrap each blockquote inner-token element so the wrapper's reported width includes the 16px indent offset — previously the indent shifted the element visually but wasn't reflected in any parent's width accounting, which could understate a blockquote's true content width when it contained wrapped or indented nested elements.
