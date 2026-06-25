# VectoUI

> A zero-DOM, Canvas 2D Entity Component System (ECS) rendering framework — 60 FPS with 100,000+ entities.

[![CI](https://github.com/Xuepoo/vecto-ui/actions/workflows/ci.yml/badge.svg)](https://github.com/Xuepoo/vecto-ui/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

## Why VectoUI?

Traditional DOM frameworks (React, Vue) cause Reflow/Repaint bottlenecks when animating thousands of elements. VectoUI bypasses the DOM entirely: layout, hit-testing, animations, and physics are calculated as pure mathematics on a **Virtual Math Tree (VMT)**, then dispatched to a `<canvas>` renderer.

### Measured performance

Reproduce with `bun run benchmark` (headless Chrome, Canvas 2D, simple filled-circle
entities, vsync/frame-rate cap disabled). Numbers are per-machine and entity-complexity
dependent.

| Entities | all on-screen   | mostly off-screen (culled) | static, idle (`onDemand`) |
| -------- | --------------- | -------------------------- | ------------------------- |
| 1,000    | ~4 ms (240 fps) | ~2.4 ms (410 fps)          | ~0 (frame cost ⟂ N)       |
| 10,000   | ~19 ms (52 fps) | **~16 ms (63 fps ✅)**     | ~0 (frame cost ⟂ N)       |
| 100,000  | ~156 ms (6 fps) | ~137 ms (7 fps)            | **~0 (frame cost ⟂ N)**   |

- **Viewport culling** (opt in per entity via `getBounds()`): off-screen entities are skipped —
  lifts large/scrolled worlds; a 10k off-screen-heavy scene holds 60 FPS.
- **On-demand redraw** (`scene.renderMode = 'onDemand'` + `markDirty()`): a static scene renders
  once then idles, so a 100k-entity UI costs the same as an empty one when nothing changes.
- 100k entities _fully on-screen_ are still ~6–7 FPS — the bottleneck there is per-entity canvas
  draw calls. Next levers: draw-call batching and a WebGL/WebGPU backend behind `IRenderer`.

## Architecture

```
.----------------------------------------------.
|          Demo Applications                   |
|  (Hooke's Law / Bad Apple / Bubbles)         |
'----------------------.------------------------'
                       |
.----------------------v------------------------.
|            @vecto/core                        |
|  .----------.  .----------------------------. |
|  |  Scene   |  |   LayoutEngine             | |
|  |  Entity  |  |   SpatialHashGrid (O(1))   | |
|  |  ECS     |  |   LayoutResultBuffer (GC0) | |
|  '----------'  '----------------------------' |
'----------------------.------------------------'
                       |
.----------------------v------------------------.
|        CanvasRenderer (Canvas 2D)             |
|              HTML <canvas>                    |
'-----------------------------------------------'
```

## Packages

| Package        | Status  | Description                                               |
| -------------- | ------- | --------------------------------------------------------- |
| `@vecto/core`  | Active  | ECS engine, LayoutEngine, SpatialHashGrid, math utilities |
| `@vecto/ui`    | Planned | High-level interactive components                         |
| `@vecto/three` | Planned | WebGL / Three.js adapter                                  |

## Quick Start

```typescript
import { Scene, Entity, IRenderer } from '@vecto-ui/core';

class CircleEntity extends Entity {
  isPointInside(x: number, y: number) {
    return Math.hypot(x - this.x, y - this.y) < 50;
  }
  render(r: IRenderer) {
    r.beginPath();
    r.fill('#38bdf8');
  }
}

const canvas = document.querySelector('canvas')!;
const scene = new Scene(canvas);
scene.add(new CircleEntity().setPosition(100, 100));
scene.start();
```

## Development

```bash
# Install dependencies
bun install

# Start demo dev server
cd apps/demo && bun run dev

# Run unit tests
cd packages/core && bunx vitest run

# Watch mode
cd packages/core && bunx vitest
```

## License

MIT (c) 2026 Xuepoo
