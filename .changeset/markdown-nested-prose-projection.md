---
'@vectojs/markdown': patch
---

fix(markdown): tag prose/code nested in quote/list containers for projection negotiation

`classifyProjectionBlocks` classified only top-level blocks, so prose nested in blockquotes and list items kept `domKind ''` and stayed canvas in hybrid/dom modes — while the docs claimed container children negotiate individually. The pass now recurses into container children with the same block mapping (nested `Text`/`RichText` to `prose`, `CodeBlock` to `code`; tables stay canvas even when nested). Also documents the projection-policy switcher in the README (now current through 0.25.0).
