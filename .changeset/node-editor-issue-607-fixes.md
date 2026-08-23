---
'@vectojs/node-editor': patch
---

Fix #607: keyboard-reachable ports, editor-local coordinates, duplicate link id integrity.

- Ports are now reachable by keyboard (WCAG 2.1.1): activating an output port hotspot (core synthesizes `click` from Enter/Space) starts a pending connection, activating an input port commits it, Escape cancels. New `NodeEditor.portActivated`.
- Drag deltas, connection targeting (`findPortAt`) and the pending-link rubber line now work in the editor's own document-local coordinate space instead of raw scene coordinates, so they stay correct under scaled/translated ancestors.
- `validateLink`/`addLink` reject duplicate link ids with a new `'duplicate-link-id'` error; documents containing duplicates remain invalid at the persistence boundary (export/import already hard-fail).
- Undo/redo ends any in-flight drag or connection first, so a mid-drag Ctrl+Z no longer teleports the dragged node or commits a bogus history entry.
- `cloneDocument` deep-clones nested `data`, so history snapshots can no longer alias nested records mutated in place. Cycle policy is documented on `validateLink` (self-loops rejected, multi-node cycles allowed).
