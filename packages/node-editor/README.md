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

The first phase intentionally renders concise node labels only. Long-text
editing, ports, persistence, layout, and collaboration remain application or
future-package concerns. Interactive nodes and the editor region are projected
through VectoJS accessibility semantics; there is no sibling DOM or CSS UI.
