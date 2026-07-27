---
'@vectojs/core': minor
'@vectojs/devtools': patch
---

Drive the DevTools tree from the scene's structure version instead of a fixed
interval.

`Scene.structureVersion` is now public. It was already maintained for the resident
WASM transform store (bumped by `Entity.add`/`remove`), and exposing it lets a
consumer replace a tree walk with an integer comparison.

The panel rebuilt both trees every 500ms regardless of whether anything changed, a
constant CPU cost proportional to entity count. It now rebuilds only when the shape
changed, with a forced reconcile every 3s as a consistency check. Selection details
still refresh every tick, since properties change without the shape changing.
