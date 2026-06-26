# The Core Scene Architecture

VectoUI discards the traditional Browser Document Object Model (DOM). Instead, it implements a **Virtual Math Tree (VMT)** inside the `@vecto-ui/core` package.

## The Scene

The `Scene` class is the orchestrator. It manages three critical pipelines:

1. **The Game Loop**: A 60 FPS `requestAnimationFrame` loop that sequentially triggers physics calculations, layout reflows, and finally rendering.
2. **Hit-Testing**: A pure mathematical O(N) or O(log N) raycasting algorithm to detect mouse hover and clicks without using `document.elementFromPoint`.
3. **Accessibility Proxy**: Bi-directional syncing of focus, layout, and values to the invisible Shadow DOM.

### Initialization

```typescript
const scene = new Scene({
  canvasId: 'canvas',
  a11yContainerId: 'a11y-container'
});
```

## The Node System

Everything in VectoUI extends the base `Node` class. A `Node` is simply an object with `x`, `y`, `width`, and `height` properties in math space.

```typescript
import { Node } from '@vecto-ui/core';

class CustomRect extends Node {
  constructor() {
    super();
    this.width = 100;
    this.height = 50;
  }

  // The custom rendering logic (executed 60 times a second)
  render(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = 'red';
    ctx.fillRect(this.x, this.y, this.width, this.height);
  }
}

const myRect = new CustomRect();
myRect.x = 200;
myRect.y = 100;
scene.add(myRect);
```

### Hit Testing and Events

Nodes can be made interactive by setting `interactive: true`. When enabled, the Scene will mathematically check if the mouse coordinates fall within the `x, y, width, height` bounding box.

```typescript
myRect.interactive = true;

myRect.on('click', (event) => {
  console.log('Math Node Clicked!', event);
  // Modify properties for instant GPU re-render
  myRect.x += 10;
});

myRect.on('mouseenter', () => {
  document.body.style.cursor = 'pointer';
});

myRect.on('mouseleave', () => {
  document.body.style.cursor = 'default';
});
```

### The Rendering Pipeline

When you call `scene.start()`, the following loop executes on every frame:

1. **Clear Canvas**: `ctx.clearRect()`
2. **Update Physics**: (Optional) Run force-directed graph ticks or animations.
3. **Traverse VMT**: Recursively walk through the `scene.children` array.
4. **Render**: Call the `render(ctx)` method on every node.

Because this happens entirely in JS memory and directly dumps pixels to the Canvas, VectoUI entirely avoids the "Layout Trashing" penalty that plagues traditional React/Vue applications when animating thousands of elements.
