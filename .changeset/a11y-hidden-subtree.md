---
'@vectojs/core': minor
'@vectojs/ui': patch
---

Hiding an `Overlay` now hides its children from assistive technology too.

`Overlay.hide()` dropped its own `interactive` and pruned its a11y subtree, which
looked sufficient. It was not: the projection walk still descended into the hidden
overlay, so any still-interactive **child** was re-created on the very next frame.
Measured in a real browser — after `Popover.hide()` the popover's own element was
gone while its button remained projected with `tabIndex: 0` and a live box, so a
keyboard user could Tab into a hidden popover and activate it.

`Entity.a11yHidden` is the new opt-out: it removes an entity **and its whole
subtree** from projection regardless of each node's own `interactive` flag, for a
container that is logically closed while still mounted. `Overlay.hide()` sets it and
`show*()` clears it.

Deliberately not inferred from `opacity`. `Overlay.hide()` springs opacity toward 0
rather than assigning it, so mid-transition it reads nonzero (~0.26 when measured)
and an `=== 0` test never fires — and a threshold would silently un-project a
faint-but-live control.
