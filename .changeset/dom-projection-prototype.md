---
'@vectojs/dom': minor
'@vectojs/core': minor
---

New `@vectojs/dom` P1 prototype (RFC2, CTX-0598): `DOMProjection` backend behind the `ProjectionBackend` mount/update/unmount interface — world-matrix to CSS `matrix3d()` sync with mandatory `transform-origin: 0 0`, tag-keyed element pool, dirty-checked per-frame updates, DOM event bridge with `source: 'dom'` attribution plus Selection/Orbit interaction-mode remap, ResizeObserver intrinsic-size readout, and focus-sentinel fallback. Prototype node set: `DOMText` / `DOMButton` / `DOMInput` / `DOMContainer` / `DOMTransform` (explicit `domPolicy: 'dom'` opt-in only; `'auto'` is CTX-0601). Core side (additive): `VectoEventSource` + `VectoJSEvent.source`, `Entity.domPolicy` / `domKind` / `domResident` plain-data fields, `Scene.addProjectionBackend` / `removeProjectionBackend`, render-walk hook + prune pass, `shouldProjectA11y` gate so a `'dom'`-policy node's live element replaces its transparent mirror.
