# @vectojs/video-exporter

## 0.2.2

### Patch Changes

- Keep the existing API and CLI while making exports reliable: validate options, serve local entries
  without source-tree files, resolve Chromium portably, write output atomically, supervise FFmpeg
  backpressure and termination, and clean up all resources on errors, aborts, SIGINT, and SIGTERM.

## 0.2.1

### Patch Changes

- Remove the unused `@vectojs/core` runtime dependency from the video exporter package manifest.
- Clean the build output, exclude test artifacts from the published package, and emit the declared
  TypeScript definitions.

## 0.2.0

### Minor Changes

- Add `@vectojs/video-exporter` for rendering scenes to MP4 videos. Expose `Scene.step(dt)` in `@vectojs/core` for deterministic clock control.

### Patch Changes

- Updated dependencies
  - @vectojs/core@0.2.2
