# @vecto-ui/core

> A zero-DOM, Canvas 2D Entity Component System (ECS) rendering framework — 60 FPS with 100,000+ entities.

Part of the **VectoUI** ecosystem.

## Why @vecto-ui/core?

Traditional DOM frameworks (React, Vue) cause Reflow/Repaint bottlenecks when animating thousands of elements. `@vecto-ui/core` bypasses the DOM entirely: layout, hit-testing, animations, and physics are calculated as pure mathematics on a **Virtual Math Tree (VMT)**, then dispatched to a `<canvas>` renderer.

| Entities | DOM (React) | @vecto-ui/core Canvas |
| -------- | ----------- | --------------------- |
| 1,000    | ~30 FPS     | 60 FPS                |
| 10,000   | <5 FPS      | 60 FPS                |
| 100,000  | Crash       | 60 FPS                |

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

## License

MIT (c) 2026 Xuepoo
