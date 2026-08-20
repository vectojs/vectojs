# @vectojs/node-editor

Canvas-native node and link editing primitives for VectoJS. The package has no
dependency on `@vectojs/desktop`: applications own the `NodeDocument`, while the
editor owns selection, pointer transactions, and undo/redo history.

```ts
import { Scene } from '@vectojs/core';
import { NodeEditor } from '@vectojs/node-editor';

const scene = new Scene(canvas, { renderMode: 'onDemand' });
const editor = new NodeEditor({
  document: {
    nodes: [{ id: 'source', type: 'input', title: 'Source', position: { x: 80, y: 100 } }],
    links: [],
  },
});
scene.add(editor);
```

Nodes can declare typed input and output ports. Drag from an output port to an
input port to create a link; the connection is committed as one undoable
command only when the target is valid. Escape/cancel, incompatible types,
duplicate links, occupied inputs, and non-port targets leave the document and
history unchanged. `deleteLink()` is also undoable.

Port hotspots are projected as accessible buttons with direction and node
labels. Rendering remains canvas-native and the editor works with
`renderMode = 'onDemand'`; applications should call `scene.markDirty()` after
external document changes.

## Persistence

Persistence is explicit and JSON-only; it never reads browser storage. Use
`serializeDocument()` and `deserializeDocument()` for a versioned, validated
document format:

```ts
const saved = serializeDocument(editor.document);
const restored = deserializeDocument(saved);
```

Malformed documents, unsupported schema versions, invalid port references, and
non-JSON data are rejected. Serialization and deserialization use deep clones.
Collaboration and table/markdown app integration remain outside this package.

## Deterministic auto-layout

`layoutDocument()` is an optional, dependency-free layout helper. It places
source-to-target links in layers, sorts nodes within a layer by stable ID, and
compresses cycles into one layer. Nodes without links are placed in the first
layer. It preserves node dimensions and data and returns a new document:

```ts
import { layoutDocument } from '@vectojs/node-editor';

const laidOut = layoutDocument(document, {
  originX: 80,
  originY: 100,
  horizontalGap: 260,
  verticalGap: 120,
});
```

`NodeEditor.applyAutoLayout()` applies the same result as one undoable command.
The helper is canvas-native and does not add a runtime dependency on
`@vectojs/graph-layout`.
