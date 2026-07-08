---
'@vectojs/ui': patch
---

Fix `Markdown`'s blockquote rendering: the left accent border and the quote text were meant to overlay at the same position, but were built inside a `Stack`, whose `add()` re-runs sequential auto-layout on every call — silently moving the text below the border instead of overlaying it, while the container still reported a height that didn't cover the (mis)placed text. The overlay container is now a plain, non-layouting entity, so the border and text render together as intended.
