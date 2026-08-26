# @vectojs/core

`@vectojs/core` is the runtime at the root of the VectoJS dependency graph: a retained
`Scene`/`Entity` scene graph (the Virtual Math Tree) that renders to a single canvas, with
transforms, render scheduling, spatial hit-testing, DOM-like event propagation, layout and text
engines, Canvas/SVG/WebGL/WebGPU renderer backends, and the accessibility/automation projection
layer. It is also the composition point of the framework — it depends on and re-exports
`@vectojs/layout`, `@vectojs/text`, `@vectojs/math`, and `@vectojs/animation`, so `@vectojs/ui`
and every higher-level package build directly on it.

## Install

```bash
bun add @vectojs/core
```

## Usage

```ts
import { Entity, type IRenderer, Scene } from '@vectojs/core';

class Dot extends Entity {
  constructor() {
    super();
    this.width = 48;
    this.height = 48;
    this.interactive = true;
    this.on('click', () => this.animate({ scaleX: 1.25, scaleY: 1.25 }, 120));
  }

  isPointInside(globalX: number, globalY: number): boolean {
    const local = this.worldToLocal(globalX, globalY);
    return !!local && Math.hypot(local.x - 24, local.y - 24) <= 24;
  }

  getA11yAttributes() {
    return { tag: 'button' as const, role: 'button', label: 'Animated dot' };
  }

  render(renderer: IRenderer): void {
    renderer.beginPath();
    renderer.arc(24, 24, 24, 0, Math.PI * 2);
    renderer.fill('#22d3ee');
  }
}

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const scene = new Scene(canvas);
scene.renderMode = 'onDemand';
scene.add(new Dot().setPosition(80, 80));
scene.start();
```

## Highlights

- Retained `Scene`/`Entity` tree with affine transforms, capture/bubble event dispatch,
  viewport culling, and dirty-flag `renderMode: 'onDemand'` rendering; `scene.step(dt)` drives a
  deterministic frame for tests and video export.
- Backend-neutral `IRenderer` drawing contract with modular backends: `CanvasRenderer`,
  `SVGRenderer`, batched WebGL points (`WebGLPointRenderer`), and WebGPU particle compute
  (`WebGPUParticleSystemManager`) — registered on load via `Scene.register*`, selected through
  `pointBackend` / `particleBackend` options.
- Optional Rust WASM kernels (`crates/vectojs-core-rs`) hot-swapped per subsystem with
  `scene.enableWasmTransforms / enableWasmHitTest / enableWasmAnimBatching / enableWasmParticles`;
  fallible exports return `WASM_STATUS` codes (`OK`/`CAPACITY`/`UNINITIALIZED`/`BAD_RUN`/
  `OVERFLOW`) so any rejected batch degrades to the JS path instead of rendering half-written state.
- Semantic accessibility projection: entities implementing `getA11yAttributes()` get transparent,
  position-synchronized DOM mirrors for screen readers, keyboard users, Playwright, and AI agents;
  static text opts into browser-native selection/find/copy through `getContentProjection()` and
  Core's prepared content grid (`prepareContentGrid()`).
- Entity-based text renderers stay here because they extend `Entity`: `TextEntity`,
  `GridTextEntity`, GPU-resolved `MSDFTextEntity` (off-thread layout via `LayoutWorkerManager`),
  `SVGEntity`, and `DOMPortalEntity`.
- The standalone engines are re-exported from this barrel and remain available as subpaths, so
  existing imports keep working:
  `@vectojs/core/layout`, `@vectojs/core/text`, `@vectojs/core/renderer`.
- Lifecycle ownership is explicit: a `Scene` owns renderers, workers, observers, and projected DOM
  nodes; `scene.destroy()` releases all of them.

> Documents @vectojs/core@1.39.0.

## Documentation

- [Core Scene architecture](https://vectojs.org/learn/core-scene/)
- [`@vectojs/core` API reference](https://vectojs.org/reference/core-api/)
- [`Entity` reference](https://vectojs.org/reference/core-entity/)
- [Renderers reference](https://vectojs.org/reference/core-renderer/)
- [Accessibility & automation guide](https://vectojs.org/learn/accessibility/)
