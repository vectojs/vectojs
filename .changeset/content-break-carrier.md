---
'@vectojs/core': patch
---

Stop a projected hard break from painting a selection bar

A projected line carries its own trailing newline so copy, find-in-page and
screen readers stay line-broken. Written as ordinary inline text in a
`white-space: pre` carrier, that `\n` is a real preserved character and the
browser gives it a selection rectangle of zero width and full line height, which
Chrome paints as a caret-like vertical bar just past the last glyph — ink the
canvas never drew. Measured on a live page at DPR 1.76, one paragraph line
produced such a rect at `x 495.18, w 0, h 31.82`; a code block produced one on
every row owning a break, including the empty row whose whole content is the
break.

Hard breaks now go into their own `font-size: 0` carrier, which keeps the
character selectable, copyable and announced while collapsing the line box it
would otherwise contribute. Soft-wrap separators are left as plain text: their
width is part of the line the canvas measured, and collapsing them shortened the
selection box by a whole space.
