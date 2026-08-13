---
'@vectojs/core': patch
---

A11y shadow nodes are now `user-select: none` (#526). They inherited `user-select: text` from the a11y root, so a drag-selection across the page swept every interactive mirror's label into the native selection alongside the real content projection. Mirrors exist for assistive technology and synthetic input, not for selection; selectable text still comes from the content projection carriers, which are unaffected.
