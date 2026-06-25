# VectoUI Framework

VectoUI is a revolutionary, high-performance mathematical UI rendering framework driven by the AST generated from [Vectomancy](https://github.com/Xuepoo/vectomancy).

Unlike traditional DOM-based frameworks (React, Vue), VectoUI operates entirely on a **Virtual Math Tree (VMT)**, calculating layout, hit-testing, and dynamic animations purely via mathematical vectors before dispatching them to a Canvas 2D or WebGL renderer.

## Features

- **Zero-DOM Rendering**: Bypasses browser Reflow/Repaint bottlenecks.
- **10k+ Entities at 60FPS**: Demonstrates O(N) linear performance scaling.
- **Infinite Resolution**: Everything is a Bezier curve; scaling never pixelates.
- **Vectomancy Integration**: Consumes raw mathematical ASTs directly from Rust.

## Packages

- `@vecto/core`: The core layout and math engine.
- `@vecto/ui`: Reusable high-level interactive components.
- `@vecto/three`: 3D and WebGL adapters.

## Quick Start

_Documentation coming soon._
