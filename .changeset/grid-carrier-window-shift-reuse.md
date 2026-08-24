---
'@vectojs/core': patch
---

Backlog: in-place grid carrier reuse on window shift, Space-on-keyup activation, hardened SVG dimension parsing (#651)

- Content-grid carriers whose per-line signature matches are now kept across a
  scrolled window instead of rebuilt: the absolute line index (and, when no
  projected line supplies an explicit `y`, the index-derived `top`) is restamped
  on the existing node. Blank rows in tall code blocks no longer re-create their
  carriers every frame while scrolling.
- Keyboard activation for projected interactive roles follows APG: Enter
  activates on keydown as before, Space now activates on keyup so press-and-hold
  no longer multi-fires; keydown Space still preventDefaults page scroll.
- `SVGEntity` dimension parsing: the open tag is scanned with quote awareness
  (`>` inside an attribute value no longer truncates it), viewBox parts must be
  finite (no NaN flows into rasterization), and percentage width/height is
  treated as absent so `viewBox` decides.

Refs #651
