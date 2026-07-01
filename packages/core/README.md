# @vectojs/core

> The Zero-DOM, Canvas-native rendering engine behind **VectoJS** — ECS + Virtual Math Tree,
> with an accessibility/automation shadow layer.

Part of the [VectoJS](https://github.com/vectojs/vectojs) ecosystem.

## What it does

`@vectojs/core` renders a whole UI onto one `<canvas>`: layout, hit-testing, animation and
physics are pure math on a Virtual Math Tree, dispatched to a Canvas 2D (or WebGL2) renderer —
**no per-element DOM, no reflow, no style recalc**. Interactive entities project a real,
transparent DOM node through the **`a11yRoot`** shadow layer, so a pure-canvas page stays
accessible and drivable by assistive tech and AI agents.

Includes: `Scene` (render loop + a11y sync), `Entity` (ECS base), `LayoutEngine` (Intl.Segmenter
with a cold/hot `prepare`/`layoutPrepared` split), `SpatialHashGrid`, `LayoutResultBuffer`
(zero-GC), `SplineEntity` (native vectomancy math-curve rendering + curve-accurate hit-testing),
`CanvasRenderer`, and a `WebGLPointRenderer` point/rect batch layer.

## Performance

See the [main README](https://github.com/vectojs/vectojs#measured-performance) for measured,
reproducible numbers (`bun run benchmark` / `bun run compare:dom`). Headline levers: viewport
culling, on-demand redraw, draw-call batching, a WebGL2 point layer, and a cold/hot text layout
split (~3.5× faster reflow). No fabricated comparisons — numbers are per-machine and
complexity-dependent.

## Quick Start

```typescript
import { Scene, Entity, IRenderer } from '@vectojs/core';

class CircleEntity extends Entity {
  isPointInside(x: number, y: number) {
    return Math.hypot(x - this.x, y - this.y) < 50;
  }
  render(r: IRenderer) {
    r.beginPath();
    r.arc(0, 0, 50, 0, Math.PI * 2);
    r.fill('#38bdf8');
  }
}

const canvas = document.querySelector('canvas')!;
const scene = new Scene(canvas);
scene.add(new CircleEntity().setPosition(100, 100));
scene.start();
```

For high-level accessible components (Button, Input, Card…), see
[`@vectojs/ui`](https://www.npmjs.com/package/@vectojs/ui).

## License

MIT © 2026 Xuepoo
