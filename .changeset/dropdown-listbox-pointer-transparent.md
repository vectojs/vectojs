---
'@vectojs/ui': patch
---

Fix `Dropdown` menu options being unselectable with a real pointer click.

The menu's listbox container projected to the a11y layer without an explicit
`pointerEvents`, so its mirror stayed hit-testable. The scene's per-mirror
`pointerdown` wiring calls `setPointerCapture` on every projected element a
gesture bubbles through, so the container overrode the option's own capture and
the browser retargeted `pointerup` + `click` to the listbox — which has no click
handler. Opening the menu worked, clicking an option did nothing, and the menu
stayed open. Keyboard selection was unaffected.

The container is now projected `pointerEvents: 'none'`, matching the Zero-DOM
a11y hotspot pattern used by `RadioGroup`, `Tabs`, `Tree`, `Table`, and
`ContextMenu`; only the leaf option buttons remain clickable.
