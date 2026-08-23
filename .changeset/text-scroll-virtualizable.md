---
'@vectojs/ui': minor
---

`Text` implements ScrollView's duck-typed `ScrollVirtualizable` contract: a
`ScrollView` whose content contains a `Text` now pushes the live viewport via
`Text.setVisibleRange(scrollY, viewportHeight)` every frame, and both of Text's
draw paths skip lines outside that window (plus a two-line overscan). Tall
selectable text no longer pays the full per-frame `fillText` cost while
scrolled. Texts that are never driven render every line exactly as before, and
any full relayout (`setText` / `setMaxWidth` / `setTextAlign`) resets the
window until the next drive.
