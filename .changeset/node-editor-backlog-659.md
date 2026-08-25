---
'@vectojs/node-editor': minor
---

Clear the node-editor backlog (#659): deletion command, keyboard path, drag cost, strict import

- **Node deletion**: new `removeNode(document, id)` model helper drops a node
  and every link touching it (same copy semantics as `removeLink`), exposed as
  `NodeEditor.deleteNodes(ids)` — one undoable `'Delete nodes'` command that
  first ends any active connection/drag and clears the selection.
- **Keyboard parity (WCAG 2.1.1)**: `Delete`/`Backspace` now routes to
  `deleteNodes(selection.list())`; `Escape` while a connection is armed
  announces the cancellation.
- **Status announcements**: an invisible aggregate live region
  (`role="status"`, `aria-live="polite"`) announces keyboard-only transitions —
  pending connection ("Linking from …"), committed link, cancelled connection.
  Pointer gestures keep their visible rubber line and are not announced.
- **Connection drop resolves in reverse add-order** (`findPortAt`): overlapping
  cards wire to the topmost (last-rendered) card's port instead of a hidden one.
- **Drag preview no longer clones the document per pointermove** — only the
  dragged node's position mutates and its entity repositions; links follow via
  the entity map each frame. endDrag/cancelDrag semantics unchanged.
- **Stricter persistence import/export**: after structural checks,
  `validateDocument` now runs the runtime `validateLink` over every link
  (against the rest of the document), so persisted documents are guaranteed to
  re-create in the editor — self-loops, duplicate endpoint quadruples and
  port direction/type/maxConnections violations reject with
  `links[i]: <verdict.error>`.
- **Breaking**: `CommandHistory.document` getter removed (it duplicated
  `currentDocument`) — call `currentDocument`. `SelectionState.toggle` removed
  (zero callers); selection snapshots use `SelectionState.list()`.

Fixes #659 (node-editor items)
