# Getting Started

This guide will walk you through setting up your first VectoUI project.

## 1. Installation

VectoUI is divided into a core mathematical engine and a set of UI components. You can install them via npm, yarn, pnpm, or bun.

```bash
bun add @vecto-ui/core @vecto-ui/ui
```

## 2. Basic Setup

To use VectoUI, you need two things in your HTML:
1. A `<canvas>` element for the high-performance visual rendering.
2. An empty `<div>` container to act as the invisible Shadow DOM layer for accessibility and native inputs.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>My First VectoUI App</title>
  <style>
    body { margin: 0; overflow: hidden; background: #0a0a0f; }
    #canvas { display: block; width: 100vw; height: 100vh; }
  </style>
</head>
<body>
  <canvas id="canvas"></canvas>
  <div id="a11y-container"></div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

## 3. Creating a Scene

In your `main.ts`, initialize the `Scene`. The Scene is the root mathematical graph that manages the rendering loop, hit-testing, and the Virtual Math Tree.

```typescript
import { Scene } from '@vecto-ui/core';

// 1. Initialize the Core Scene
const scene = new Scene({
  canvasId: 'canvas',
  a11yContainerId: 'a11y-container',
});

// 2. Start the rendering loop
scene.start();
```

## 4. Adding UI Components

Now let's add a high-end glassmorphism `Toggle` component from the `@vecto-ui/ui` package to the scene.

```typescript
import { Scene } from '@vecto-ui/core';
import { Toggle } from '@vecto-ui/ui';

const scene = new Scene({
  canvasId: 'canvas',
  a11yContainerId: 'a11y-container',
});

// Create a Toggle Component
const physicsToggle = new Toggle({
  label: 'Physics Engine',
  checked: true,
  font: '400 14px "Outfit", sans-serif',
  color: '#fff',
  accent: '#00f0ff',
  onChange: (checked) => {
    console.log('Physics Engine is now:', checked ? 'ON' : 'OFF');
  }
});

// Position it in the mathematical space
physicsToggle.x = 50;
physicsToggle.y = 50;

// Add it to the Scene's Virtual Math Tree
scene.add(physicsToggle);

scene.start();
```

## Next Steps

Congratulations! You have successfully rendered a VectoUI scene. The toggle you just added is rendered entirely on the GPU, but if you inspect the DOM, you will see a native hidden `<div role="switch">` perfectly tracking it!

Check out the [Core Scene Architecture](./core-scene.md) to learn how to manipulate the Virtual Math Tree.
