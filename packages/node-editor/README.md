# @vectojs/node-editor

Canvas-native node and link editing for VectoJS: a `NodeEditor` entity that renders and edits a typed `NodeDocument` of nodes, ports, and links as canvas cards, plus renderer-neutral helpers — document commands, selection, whole-document undo history, strict persistence, and deterministic layered auto-layout. Applications own the document; the editor owns gestures, validation, and history. It peers only on `@vectojs/core` and `@vectojs/ui` and carries no dependency on `@vectojs/desktop`, so it slots into any host scene.

## Install

```bash
bun add @vectojs/node-editor
```

`@vectojs/core` and `@vectojs/ui` are peer dependencies and must be installed explicitly.

## Usage

```ts
import { Scene } from '@vectojs/core';
import { NodeEditor, createDocument } from '@vectojs/node-editor';

const scene = new Scene(canvas, { renderMode: 'onDemand' });

const editor = new NodeEditor({
  width: 1000,
  height: 700,
  document: createDocument({
    nodes: [
      { id: 'source', type: 'input', title: 'Source', position: { x: 80, y: 100 } },
      {
        id: 'gain',
        type: 'process',
        title: 'Gain',
        position: { x: 380, y: 100 },
        ports: [
          { id: 'in', direction: 'input' },
          { id: 'out', direction: 'output' },
        ],
      },
    ],
    links: [],
  }),
});
scene.add(editor);

editor.createLink({
  id: 'l1',
  source: 'source',
  target: 'gain',
  sourcePort: 'out',
  targetPort: 'in',
}); // validated against the rule set, then committed as one undoable command
editor.undo();
editor.redo();
editor.applyAutoLayout(); // deterministic layered layout, also undoable
```

## Highlights

- Every mutation is a single undoable command over whole-document snapshots (`CommandHistory.execute`/`undo`/`redo`), so undo/redo never lands mid-gesture; undo and redo end any in-flight drag or connection first.
- Links are validated before commitment — missing endpoints, self-loops, duplicate ids or endpoint pairs, port direction/type mismatches, occupied inputs, and non-port targets all throw or reject without touching the document or history.
- `deleteNodes(ids)` removes the given nodes plus every incident link in one command; headless `removeNode(document, id)` keeps documents referentially valid the same way.
- Ports are keyboard-reachable: each hotspot projects as a focusable `role="button"`, keyboard activation arms/commits connections (pointer clicks never leave phantom pending connections), and transitions announce through an aggregate `role="status"` live region.
- Persistence is explicit JSON with schema-version stamping (`exportDocument`/`importDocument`, aliases `serializeDocument`/`deserializeDocument`); import validates structurally and semantically through runtime `validateLink`, rejecting malformed data, unsupported versions, and links impossible to re-create.
- `layoutDocument()` places source-to-target links in deterministic layers (Tarjan SCC, then longest-path ranking; stable ID sort within layers) and never mutates its input — dependency-free, with no runtime pull toward `@vectojs/graph-layout`.
- Works under scaled or translated ancestors (document-local coordinates) and plays well with `renderMode: 'onDemand'`; call `scene.markDirty()` after external document changes.

> Documents @vectojs/node-editor@0.2.0.

## Documentation

- [`NodeEditor` reference](https://vectojs.org/reference/node-editor/)
