---
'@vectojs/ui': patch
---

Release the Modal focus trap when dismissed via hideOverlay (#691)

The document-level Tab trap was removed only by `close()`/`destroy()`, so
`scene.hideOverlay(modal)` — which unprojects the overlay without destroying
it — stranded the trap: every later Tab was preventDefault'd into the invisible
dialog and page keyboard navigation died. The handler now self-checks liveness
as its first statement and removes itself once the modal is off the tree.
