---
"@vectojs/core": patch
---

Keep a text selection alive when the a11y reading-order pass moves its carrier

`enforceA11yDomOrder` places projected elements into visual reading order with
`parent.insertBefore(expected, current)`. On an already-attached node that call
is a **move**, and moving a node destroys any `Selection` anchored inside its
subtree. During streaming this killed a selection in a settled, stationary,
on-screen block: measured with the document parked and the write head ~300
sections away, a selection held 176 characters across three sync passes and
collapsed in the exact pass that moved its carrier, with `removedNodes` and
`addedNodes` both recording the same node and `isConnected` still true — so no
eviction or rebuild path was involved.

The pass already recognised and repaired this class of damage for
`document.activeElement` (a moved mirror blanks focus, which silently broke
`Dropdown`'s Escape-to-close). Selection now gets the same treatment: the
endpoints are snapshotted once per pass, each moved element is tested for
containment, and the range is re-applied after the loop.

Notes on the shape of the fix:

- Snapshot is taken **once per pass**, not per moved element. Every `Selection`
  property read forces layout, and the loop runs one iteration per projected
  element. The existing `contentSelectionPresent()` memo gates it, so a pass
  with no selection anywhere in the document costs nothing.
- Restore happens **after** the loop, not per move, because a selection
  spanning two carriers can have both of them moved — re-applying between the
  two would only be undone by the second move.
- No offset remapping is needed. A move preserves the text nodes, so the
  snapshotted nodes and offsets stay valid. This is what makes it simpler than
  `preserveContentSelectionAcrossRebuild`, which must reason in linear
  character offsets because a rebuild replaces the nodes.
