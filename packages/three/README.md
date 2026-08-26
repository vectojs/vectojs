# @vectojs/three

WebGL bridge between VectoJS and Three.js, with two exports for two different jobs: `ThreeAdapter` renders a live VectoJS 2D UI onto a canvas wrapped as a `THREE.CanvasTexture` — routing raycast pointer input, panel focus, and synthetic keyboard dispatch back into the scene — while `ThreeRenderer` uses Three.js itself as the rendering backend of a VectoJS `Scene`. In the dependency graph it is a leaf rendering integration: it peers only on `@vectojs/core` and `three`, and is consumed by hosts that already own a Three.js or WebXR scene rather than by other VectoJS packages.

## Install

```bash
bun add @vectojs/three
```

`@vectojs/core` and `three` are peer dependencies and must be installed explicitly. For TypeScript, add `@types/three`.

## Usage

```ts
import * as THREE from 'three';
import { Button, Stack, Text } from '@vectojs/ui';
import { ThreeAdapter } from '@vectojs/three';

const adapter = new ThreeAdapter({ width: 512, height: 256 });
const stack = new Stack({ direction: 'vertical', gap: 12 });
const apply = new Button('Apply');
apply.on('click', () => console.log('applied'));
stack.add(new Text('Settings'));
stack.add(apply);
adapter.vectoScene.add(stack);
adapter.vectoScene.start();
myThreeScene.add(adapter.mesh); // ready-made textured plane

// Logical-coordinate input without a raycaster (tests, automation, tools):
adapter.dispatchPointer('pointerdown', 60, 30);
adapter.dispatchPointer('pointerup', 60, 30);

// Panel focus drives key routing. Keyboard owners — entities projecting an
// input/textarea/select tag or a role from core's KEYBOARD_OWNING_ROLES
// (button, textbox, slider, ...) — consume keys instead of leaking them to
// the page, so arrows move a slider instead of orbiting your camera.
if (adapter.isFocusable(apply)) adapter.focus(apply);
adapter.dispatchKey('Enter'); // routed at the focused entity's projection
console.log(adapter.focusedEntity === apply); // true
adapter.blur();
```

In a real application, drive pointer input with `updateIntersection(raycaster, type, originalEvent)` inside your pointer listeners and render loop; `dispatchKey`/`dispatchPointer` are the raycaster-free equivalents over logical scene coordinates. Wheel events have no neutral defaults and stay on the `updateIntersection` path.

## Highlights

- Two exports, two contracts: `ThreeAdapter` puts a VectoJS UI into an existing Three.js/WebXR scene; `ThreeRenderer` replaces Canvas 2D with hardware-accelerated Three.js primitives behind the normal `IRenderer` surface.
- Texture sync without polling: a render hook sets `texture.needsUpdate` after every VectoJS frame, so on-demand scenes upload only when their visual state changes.
- Panel focus model (`focus`/`blur`/`focusedEntity`/`isFocusable`) bridges synthetic `FocusEvent`s through core-side state so caret blink and focus emits match a connected canvas; pointerdown focuses the nearest focusable ancestor of the hit.
- Keyboard ownership via core's `KEYBOARD_OWNING_ROLES`: while a focused owner holds keys they never reach the page; otherwise events forward to `window` under native gates (`defaultPrevented`, auto-repeat, page-level keyboard owners), and an entity handler calling `preventDefault()` suppresses the forward.
- Raycast UVs are remapped into the scene's logical space with automatic Y flip and DPR-correct hit-testing on HiDPI displays (physical-size mapping was fixed in 0.1.2).
- Per-pointerId hover state gives WebXR controllers and multi-touch inputs independent hover/focus contexts.
- Idempotent `dispose()` releases texture, geometry, and material, restores the Scene render hook, destroys the inner VectoJS scene, and clears per-pointer state including panel focus.

> Documents @vectojs/three@0.2.0.

## Documentation

- [Overview](https://vectojs.org/reference/three/)
- [`ThreeAdapter`](https://vectojs.org/reference/three-adapter/)
- [`ThreeRenderer`](https://vectojs.org/reference/three-renderer/)
