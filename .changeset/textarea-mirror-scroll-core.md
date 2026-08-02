---
"@vectojs/core": minor
---

Project a text-input mirror's scroll offset to its entity.

An interactive entity's shadow node now emits a `'scroll'` `VectoEvent` carrying
a `ScrollEventPayload` (`scrollTop`/`scrollLeft`, `scrollHeight`/`scrollWidth`,
`clientHeight`/`clientWidth`) whenever the browser scrolls it — a wheel gesture,
a scrollbar drag, or scrolling a caret back into view — plus once at creation so
an entity agrees with its mirror on the first frame rather than from the first
gesture. There was previously no way for an entity to observe the scroll offset
its own mirror was using, so any offset the element reported (a click's
`selectionStart`) was measured against a view the canvas was not drawing.

Text-input mirrors also get `scrollbar-width: none`. The mirror is transparent so
a scrollbar is never seen, but a classic one takes its width out of the content
box: measured on Firefox/Linux at 12px, which made the element wrap its text at
480px while the canvas wrapped at 492px, so the two disagreed about which line a
character sat on. Chromium's overlay scrollbar took 0 and already agreed.
