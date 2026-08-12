---
'@vectojs/ui': patch
---

Image with an empty `alt` no longer projects an empty `aria-label` on its
shadow `<img>` node — a presentation-only image (`alt: ''`) used to emit
`aria-label=""`, which fails the ARIA `presentation-role-conflict` audit in
Lighthouse. Empty alt now projects no label attribute at all.
