---
'@vectojs/three': minor
---

ThreeAdapter: keyboard routing, panel focus management and programmatic input driving

- `dispatchKey(key, mods?, phase?)` synthesizes real `KeyboardEvent`s and routes them to the focused panel entity's projected mirror (core's key forwarding and Enter/Space activation run unchanged), then forwards to `window` so the #636 scene-level channel applies its ownership gates. Keyboard-owning roles (`KEYBOARD_OWNING_ROLES`, plus projected `input`/`textarea` tags) keep the keys panel-exclusive.
- Panel focus: `focus(entity | null)`, `blur()`, `focusedEntity`, `isFocusable(entity)`. Pointerdown on the mesh focuses the nearest focusable ancestor of the hit entity; clicking off-panel or empty background blurs. Transitions are bridged through synthetic `FocusEvent`s so core-side state (entity `focus`/`blur`, `focusedA11yElement`, caret-blink wake) matches a connected canvas.
- `dispatchPointer(type, x, y, init?)` drives pointer input at logical scene coordinates through the identical downstream path as raycast-driven `updateIntersection`, for tests and automation without a raycaster.
