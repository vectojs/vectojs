---
"@vectojs/ui": patch
---

Fix `TextArea` not scrolling with the wheel, and clicks landing on the wrong line.

`TextArea`'s scroll offset was caret-driven only: it followed `selectionStart` and
was never driven by the view. A wheel gesture landed on the shadow `<textarea>`
(the topmost node under the pointer) and scrolled it, but the canvas kept drawing
the same lines — measured in both engines, the mirror went to `scrollTop` 480 while
the canvas stayed put. The same split broke clicking: the browser resolves a click
against the mirror's view, so the caret landed on a different line than the one
under the pointer — 29 wrapped lines off at load, because the caret is seeded to
the end of the value and the canvas scrolled to the bottom while the freshly
projected mirror was still at 0.

`TextArea` now follows the offset its mirror reports (`@vectojs/core`'s new
`'scroll'` event), which fixes both: the wheel scrolls because the browser already
scrolled the real element, and clicks land correctly because both surfaces resolve
against the same view. Caret-following remains as a fallback for when there is no
mirror, such as a headless render.
