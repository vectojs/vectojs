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
external document changes. Persistence, collaboration, table/markdown apps,
and layout engine integration remain outside this package.
