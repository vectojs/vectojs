---
'@vectojs/ui': patch
---

Add visible keyboard focus rings to Checkbox and Toggle (#683)

Both components project natively-focusable shadow elements painted at
`opacity: 0`, so keyboard focus was invisible (WCAG 2.4.7). They now track
`focus`/`blur` like Button/Slider and stroke a 2px ring around the box/track,
yielding to the system `Highlight` color under forced colors.

Fixes #683
