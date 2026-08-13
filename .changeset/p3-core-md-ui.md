'@vectojs/core': patch
'@vectojs/markdown': patch
'@vectojs/ui': patch
---

P3 defects from the 2026-08-13 review, across core, markdown and ui.

- core: `Entity.remove` now unregisters the detached subtree from the batched-driver candidate set (off-tree drivers no longer tick until completion, and re-attach resumes them); `WasmBackendFacade.syncStore` clears `_aabbsFresh` on both rejection returns so a fused hit gather never reads the previous frame's AABBs after a transient kernel rejection; the content-grid zero-measurement branch publishes `vectoGridReady` from a frame callback like the probe-free branch; `parseColorToRGBA` returns opaque black for unparseable input instead of the previous parse's canvas color; `sanitizeUrl` decodes HTML character references before scheme detection so entity-encoded `javascript:` payloads rewrite to `#`; `SplineEntity` bakes at the renderer's clamped `pixelRatio` and re-bakes on change; `WebGLPointRenderer.setTexture` commits the pending sprite batch before an atlas swap; `GridTextEntity.updateGrid` sizes `cols` from the widest row; `Scene.step` docstring unit corrected to milliseconds.
- markdown: `CodeBlock.setCode` zeroes the highlight-segment reuse prefix when the language changes; the worker's per-instance raw cache is bounded with oldest-entry eviction.
- ui: `TreeView` catches lazy-load rejections, clears the loading state and rebuilds rows; virtualized `Table.layout()` re-syncs string cells of mounted rows; reassigning the public `tabs`/`options` arrays re-syncs the a11y hotspot pools; non-keyed `VirtualList.setItems` zeroes `_velY` so a replace no longer overshoots the content edge.
