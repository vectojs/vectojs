# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-06-25

### Added

- **Core ECS Engine (`@vecto/core`)**: Initial release of the extreme performance Entity Component System.
- **Rendering Engine**: Canvas 2D based extreme renderer supporting 10,000+ entities at 60 FPS.
- **Layout Engine**: High-performance text reflow and line breaking engine using `Intl.Segmenter`.
- **Physics Engine**: Hooke's Law spring physics implementation for interactive text dynamics.
- **Off-Thread Physics**: Offload spring integrations to a dedicated Web Worker via `SharedArrayBuffer` with automatic main-thread fallback.
- **Spatial Hash Grid**: Fixed-cell `SpatialHashGrid` for O(1) average-case AABB neighbor queries.
- **Zero-GC Text Layout**: Added `LayoutResultBuffer` to eliminate GC allocation pressure in heavy text reflow environments.
- **Scene & Lifecycle Management**: Added `Scene.remove()` for entity detaching, and `Entity.off()` and `Entity.destroy()` for listener and animation cleanup to prevent memory leaks.
- **Drawing Methods**: Extended `IRenderer` and `CanvasRenderer` with native `arc()`, `roundRect()`, and `drawImage()` support.
- **CI/CD Workflows**: Configured GitHub Actions pipelines for oxlint, formatting, unit tests, and Vite build validation.
- **Demos (`@vecto/demo`)**:
  - `Hooke's Law Physics Text`: Interactive drag-and-drop elastic text.
  - `Lyrics Reflow`: 60 FPS real-time exclusion mask text reflow.
  - `Classic Matrix`: High-contrast ASCII video rendering using ECS.
  - `Variable Font ASCII (Pretext)`: 256-level grayscale mapping using variable font weights and opacities to simulate extreme visual fidelity without canvas filters.

### Fixed

- Hooke's Law instability issues when dragging nodes forcefully.
- Hot Module Replacement (HMR) resource leaks during development.
- Variable Font ASCII binary thresholding issues, restoring full grayscale mapping.
- Canvas blurriness on HiDPI displays by syncing CSS dimensions in `CanvasRenderer.resize()`.
- Memory pressure in `bad-apple-lyrics` by refactoring `LyricsMaskEntity` to use `LayoutResultBuffer`.
- Memory pressure in `bad-apple-classic` by pre-allocating the character grid array.
