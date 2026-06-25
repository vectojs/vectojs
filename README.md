# VectoUI

> A zero-DOM, Canvas 2D Entity Component System (ECS) rendering framework — 60 FPS with 100,000+ entities.

[![CI](https://github.com/Xuepoo/vecto-ui/actions/workflows/ci.yml/badge.svg)](https://github.com/Xuepoo/vecto-ui/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

## Why VectoUI?

Traditional DOM frameworks (React, Vue) cause Reflow/Repaint bottlenecks when animating thousands of elements. VectoUI bypasses the DOM entirely: layout, hit-testing, animations, and physics are calculated as pure mathematics on a **Virtual Math Tree (VMT)**, then dispatched to a `<canvas>` renderer.

### Measured performance

Reproduce with `bun run benchmark` (headless Chrome, Canvas 2D, simple filled-circle
entities, vsync/frame-rate cap disabled; every entity is re-rendered each frame — there is
no dirty-checking or culling yet). Numbers are per-machine and entity-complexity dependent.

| Entities | mean ms/frame | max FPS | sustains 60 FPS |
| -------- | ------------- | ------- | --------------- |
| 1,000    | ~5 ms         | ~180    | yes             |
| 10,000   | ~23 ms        | ~44     | not yet         |
| 100,000  | ~180 ms       | ~6      | not yet         |

> These are early, unoptimized numbers. Pushing 10k+ entities back to 60 FPS is active
> work — see the roadmap (viewport culling via the spatial hash, dirty-region rendering,
> off-thread `OffscreenCanvas`, and a WebGL/WebGPU backend behind `IRenderer`).

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
