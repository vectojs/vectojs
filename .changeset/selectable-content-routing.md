---
'@vectojs/core': minor
'@vectojs/ui': minor
'@vectojs/devtools': minor
---

Make browser-native text selection a reusable VectoJS contract. Core now keeps dynamically
materialized content projections in VMT order, removes them with their subtree, hides projections
outside clipping ancestors, and exposes `Scene.getContentElement()` for tooling. UI adds
configurable selection to Text, RichText, Markdown, CodeBlock, and Table cells; projects fenced
code; preserves RichText wrap points; and gives Table an explicit, render-pure layout pass with
wrapped, single-owner cell projections. UI's Core peer range is also aligned with its stable API
contract (`>=1.0.0 <2.0.0`). DevTools event traces now report `source: "content"` for events
originating on projected selectable text.
