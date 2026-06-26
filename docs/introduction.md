# Introduction to VectoUI

Welcome to **VectoUI**, a revolutionary mathematical UI layout and WebGL hybrid rendering engine.

## What is VectoUI?

VectoUI is not just another front-end component library; it is a **bottom-up reimagined layout and rendering engine**. 
Traditional web frameworks (like React or Vue) rely on the browser's DOM for layout calculation and rendering. When handling massive amounts of elements or complex physics, the DOM becomes a critical performance bottleneck.

VectoUI takes a radically different approach:
- **Zero DOM Measurement**: It calculates all element sizes, positions, and physics entirely in memory using a pure mathematical graph.
- **Dual-Engine Rendering**: It renders the mathematical graph to a high-performance `<canvas>` (via WebGL or Canvas 2D) while seamlessly maintaining an invisible "Shadow DOM" to preserve native browser accessibility (A11y), text selection, and screen reader support.

## Why VectoUI?

### 1. Extreme Performance
By bypassing browser layout reflows, VectoUI can effortlessly animate **over 15,000 interacting nodes** at a solid 60 FPS, complete with force-directed physics, collisions, and inertia.

### 2. The Nexus Engine
At the heart of VectoUI is the `Scene` and `Node` architecture. It implements a **Virtual Math Tree (VMT)** where every UI component is just a mathematical object. This allows us to apply physics engines (like spring forces and repulsion) to standard UI components like Buttons and Inputs!

### 3. Native Accessibility (A11y)
The biggest flaw of traditional Canvas/WebGL applications is the loss of accessibility. VectoUI solves this with its **Shadow DOM projection**. When you render a `TextInput` in VectoUI, it invisibly projects a real native `<input>` over the canvas. This means users can still use native IME (Input Method Editors), screen readers, and tab navigation, while the visuals remain 100% GPU-accelerated.

## Architecture Overview

VectoUI consists of several core packages:
- `@vecto-ui/core`: The pure math engine. Contains the `Scene` loop, Hit-Testing logic, `Node` bounding boxes, and event proxies.
- `@vecto-ui/ui`: High-level glassmorphism UI components (e.g., `Input`, `Toggle`, `Panel`) built on top of the core.
- `@vecto-ui/three`: (Coming Soon) The WebGL 3D rendering backend.

Let's dive into the next section to get your first VectoUI scene up and running!
