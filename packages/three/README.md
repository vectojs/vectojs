# @vectojs/three

> Put a live VectoJS 2D interface into Three.js/WebXR and route 3D pointer input back to the canvas.

[![npm](https://img.shields.io/npm/v/@vectojs/three?color=22d3ee)](https://www.npmjs.com/package/@vectojs/three)
[![CI](https://github.com/vectojs/vectojs/actions/workflows/ci.yml/badge.svg)](https://github.com/vectojs/vectojs/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-6366f1.svg)](https://github.com/vectojs/vectojs/blob/main/LICENSE)

`@vectojs/three` renders a VectoJS `Scene` into a canvas-backed Three.js texture. The adapter maps
raycast UV coordinates into the Scene's logical coordinate space, forwards pointer/hover/wheel
events, and keeps texture uploads synchronized with VectoJS rendering.

[Live 3D demo](https://vectojs.xuepoo.xyz/demos/dimension/) ·
[Reference](https://vectojs.xuepoo.xyz/reference/three/) ·
[Main repository](https://github.com/vectojs/vectojs)

## Install

```bash
bun add @vectojs/core @vectojs/ui @vectojs/three three
```

`@vectojs/core` and `three` are peer dependencies. `@vectojs/ui` is used by the example and is
optional when you supply your own core entities.

## Basic usage

```ts
import { Button, Stack, Text } from '@vectojs/ui';
import { ThreeAdapter } from '@vectojs/three';
import * as THREE from 'three';

const scene3d = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 100);
const renderer = new THREE.WebGLRenderer({ antialias: true });

const adapter = new ThreeAdapter({
  width: 800,
  height: 500,
});

const panel = new Stack({ direction: 'vertical', gap: 16 });
panel.setPosition(36, 36);
panel.add(new Text('VectoJS in 3D', { font: '700 28px Inter' }));
panel.add(new Button('Select', { onClick: () => console.log('selected') }));
adapter.vectoScene.add(panel);
adapter.vectoScene.start();

// Use the adapter's texture/material with a mesh in your Three.js scene.
scene3d.add(adapter.mesh);
```

See the [reference](https://vectojs.xuepoo.xyz/reference/three/) for the exact constructor and
mesh/material customization supported by the installed version.

## Coordinate and event model

- VectoJS layout uses the logical `width`/`height` passed to the adapter.
- The backing canvas may be larger on HiDPI displays; raycast UVs are still mapped to logical space.
- Pointer intersections are translated into VectoJS events and routed through its normal hit-test,
  capture, target, and bubble phases.
- Hover state is tracked per pointer, including pointer leave boundaries.
- WebXR controllers can use the same raycast-to-2D route when supplied by the host application.

The adapter does not own the application's Three.js render loop, camera, controls, or raycaster.

## Texture synchronization

The adapter wraps the VectoJS Scene render path so `texture.needsUpdate` is set after a dirty frame.
On-demand VectoJS scenes therefore upload only when their visual state changes; the Three.js host
still decides when to render its own frame.

## Lifecycle

```ts
adapter.dispose();
```

`dispose()` restores the Scene render hook, releases adapter-owned Three.js resources, destroys the
inner VectoJS Scene, and detaches event state. Call it when removing the panel or unmounting the host
component.

## Constraints

- The default output is a flat textured plane; it is not DOM rendered in 3D.
- Canvas clipping and logical hit-testing remain 2D even when the mesh is rotated in world space.
- The host must provide correct raycast intersections and account for occlusion.
- Texture resolution affects sharpness and upload cost. Choose logical size and DPR for the target
  viewing distance rather than always maximizing both.
- Three.js releases outside the declared peer range are not guaranteed.

## License

[MIT](https://github.com/vectojs/vectojs/blob/main/LICENSE) © 2026 Xuepoo
