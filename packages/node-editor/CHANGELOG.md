# @vectojs/node-editor

## 0.2.0

### Minor Changes

- 53d0cd6: Clear the node-editor backlog (#659): deletion command, keyboard path, drag cost, strict import

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

### Patch Changes

- 27b925c: Fix #607: keyboard-reachable ports, editor-local coordinates, duplicate link id integrity.

  - Ports are now reachable by keyboard (WCAG 2.1.1): activating an output port hotspot (core synthesizes `click` from Enter/Space) starts a pending connection, activating an input port commits it, Escape cancels. New `NodeEditor.portActivated`.
  - Drag deltas, connection targeting (`findPortAt`) and the pending-link rubber line now work in the editor's own document-local coordinate space instead of raw scene coordinates, so they stay correct under scaled/translated ancestors.
  - `validateLink`/`addLink` reject duplicate link ids with a new `'duplicate-link-id'` error; documents containing duplicates remain invalid at the persistence boundary (export/import already hard-fail).
  - Undo/redo ends any in-flight drag or connection first, so a mid-drag Ctrl+Z no longer teleports the dragged node or commits a bogus history entry.
  - `cloneDocument` deep-clones nested `data`, so history snapshots can no longer alias nested records mutated in place. Cycle policy is documented on `validateLink` (self-loops rejected, multi-node cycles allowed).

- f226583: Fix #627 (follow-up to #624): port activation now requires keyboard provenance.
  Core dispatches entity `click` both for Enter/Space synthesis on a focused port
  hotspot and for native browser clicks on the projected mirror; only the
  keyboard path may arm or commit the connection gesture. A bare pointer click on
  a port no longer leaves a phantom pending connection, and releasing a
  connect-drag over empty space no longer re-arms through the capture-retargeted
  click. Escape cancellation while focus rests on a port hotspot is locked by a
  regression test driven at the port entity, exercising the same entity-tree
  routing production uses.

## 0.1.0

### Minor Changes

- dd22324: Add the first standalone canvas-native node editor with typed documents,
  selection and drag state, command history, and accessible scene entities.
- 07b4875: Add validated JSON `exportDocument()` and `importDocument()` helpers for node editor documents.
- 8d85083: Add a versioned, JSON-safe persistence API for node editor documents.
- 2f73d71: Add deterministic, dependency-free graph auto-layout with undoable editor integration.
- 76985ff: Keep persistence exports compatible with TypeScript 7's readonly array checks.
- dd22324: Add typed input/output ports, validated undoable link commands, pointer connection transactions, and accessible port semantics.
