# @vectojs/core

> Scene, layout, interaction, text, rendering, and semantic projection for canvas-native interfaces.

[![npm](https://img.shields.io/npm/v/@vectojs/core?color=22d3ee)](https://www.npmjs.com/package/@vectojs/core)
[![CI](https://github.com/vectojs/vectojs/actions/workflows/ci.yml/badge.svg)](https://github.com/vectojs/vectojs/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-6366f1.svg)](https://github.com/vectojs/vectojs/blob/main/LICENSE)

`@vectojs/core` is the runtime beneath VectoJS. It owns the retained `Scene`/`Entity` tree, affine
transforms, render scheduling, layout, text flow, spatial hit-testing, event propagation, renderer
backends, and the accessibility/automation projection layer.

[Core guide](https://vectojs.org/learn/core-scene/) ·
[API reference](https://vectojs.org/reference/core-api/) ·
[Main repository](https://github.com/vectojs/vectojs)

## Install

```bash
bun add @vectojs/core
```

## Minimal scene

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

## Runtime building blocks

| Area        | Main APIs                                       | Purpose                                                                |
| ----------- | ----------------------------------------------- | ---------------------------------------------------------------------- |
| Scene graph | `Scene`, `Entity`                               | ownership, transforms, lifecycle, update/render traversal              |
| Layout      | `LayoutEngine`, layout subpath                  | prepared text/rich-text layout, wrapping, exclusions, reusable buffers |
| Interaction | entity events, `SpatialHashGrid`                | hit-testing and DOM-like capture/bubble dispatch                       |
| Text        | `TextEntity`, `MSDFTextEntity`, `SplineEntity`  | Canvas text, GPU text, and mathematical curves                         |
| Rendering   | `IRenderer`, `CanvasRenderer`, renderer subpath | backend-neutral drawing contract and concrete renderers                |
| GPU paths   | WebGL point batching, WebGPU particles          | high-volume points/rects and compute-driven particles                  |
| Semantics   | `A11yAttributes`, Scene projection              | role/name/state, native inputs, screen readers, Playwright/agents      |
| Animation   | `animate`, springs, transitions, `Scene.step()` | real-time or deterministic fixed-step motion                           |

## Scene lifecycle

```ts
const scene = new Scene(canvas, {
  maxFPS: 60,
  pointBackend: 'canvas', // or 'webgl'
  particleBackend: 'cpu', // or 'webgpu' when supported
});
scene.renderMode = 'onDemand'; // redraw only when dirty

scene.resize(width, height); // logical CSS pixels
scene.markDirty();
scene.start();
scene.stop();
scene.step(1000 / 60); // deterministic single step
scene.destroy(); // release renderers, workers, observers, and semantic DOM
```

Always call `destroy()` when a framework component unmounts. A `Scene` owns browser observers,
renderer resources, layout work, and projected DOM nodes.

## Package entry points

```ts
import { Scene, Entity } from '@vectojs/core';
import { LayoutEngine } from '@vectojs/core/layout';
import type { IRenderer } from '@vectojs/core/renderer';
import { TextEntity } from '@vectojs/core/text';
```

Both ESM and CommonJS outputs are published with TypeScript declarations.

## Accessibility and automation

Canvas pixels have no semantics. Interactive entities can implement `getA11yAttributes()`; the
Scene projects transparent DOM nodes over their world-space bounds and forwards native input back
into the VectoJS event system.

This projection is intentionally thin. Applications still own accessible names, keyboard behavior,
focus order, contrast, and correct control semantics. See the
[accessibility guide](https://vectojs.org/learn/accessibility/).

Non-control workspaces that own keyboard shortcuts can opt into focus order
explicitly: return `{ role: 'region', label: 'Canvas workspace', tabIndex: 0 }`.
The Scene refreshes the projected `tabindex` when attributes change. Keep native
text inputs and editable content in charge of their own editing shortcuts.

Interactive projected nodes capture the active pointer on `pointerdown` and route
`pointermove`, `pointerup`, and `pointercancel` through normal VMT capture/bubble propagation.
Treat `pointercancel` as rollback: discard transient gesture state and do not create durable
history. Pointer capture is released safely on both completion paths.

## Static content projection

Canvas-rendered text can opt into browser-native find, translation, selection, and copy without
turning the application into a DOM layout. Override `getContentProjection()` on the owning Entity;
the Scene creates a transparent, position-synchronized mirror while the VMT remains authoritative:

```ts
class SelectableLabel extends Entity {
  getContentProjection() {
    return {
      text: 'Selectable canvas text',
      font: '18px Inter',
      lineHeight: 24,
      selectable: true,
    };
  }
}
```

`selectable` controls whether the mirror receives pointer input. The Scene keeps projection order
aligned with VMT order, removes descendant mirrors with their subtree, and hides mirrors fully
outside the viewport or a `clipChildren` ancestor. Tooling can inspect the currently materialized
node with `scene.getContentElement(entityId)`. Virtualized or non-materialized off-viewport text is
not searchable until the application brings it into the active scene.

Code-like renderers can compile their logical source once with `prepareContentGrid()` and return the
same immutable plan as `ContentProjection.grid`. The plan retains UTF-16 source ranges, legal
grapheme carets, CR/LF ownership, tab stops, wide CJK/emoji advances, Arabic shaping, and Unicode
bidi positions. Scene projects those cells in logical source order, performs font calibration in a
cold offscreen batch, and uses the plan's local geometry for pointer selection even when the entity
is rotated, scaled, or the page is zoomed.

Selection routing preserves forward/reverse drag direction, Shift extension, word and line
selection, and exact clipboard source. Projection rebuild/removal/destroy paths release active
selection and pending calibration ownership before replacing DOM carriers.

## Performance model

Useful levers include on-demand rendering, viewport culling, spatial hashing, prepared text layout,
typed reusable buffers, batched WebGL points, and optional WebGPU particle compute. None makes every
workload allocation-free or GPU-bound; profile the renderer and entity types used by your app.

Run the repository benchmarks with `bun run benchmark`, `bun run compare:dom`, and
`bun run compare`. Prepared-grid scaling can be measured independently with
`bun run --cwd packages/core benchmark:grid`; benchmark timing is release evidence rather than a
wall-clock CI gate.

## Related packages

- [`@vectojs/ui`](https://github.com/vectojs/vectojs/tree/main/packages/ui) — high-level accessible components
- [`@vectojs/three`](https://github.com/vectojs/vectojs/tree/main/packages/three) — Three.js/WebXR projection and raycast routing
- [`@vectojs/video-exporter`](https://github.com/vectojs/vectojs/tree/main/packages/video-exporter) — deterministic H.264 capture

## License

[MIT](https://github.com/vectojs/vectojs/blob/main/LICENSE) © 2026 Xuepoo
