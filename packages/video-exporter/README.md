# @vectojs/video-exporter

Deterministic video export for VectoJS scenes: a CLI (`vecto-export`) and an `exportVideo()` API that drive a page's scene in headless Chromium one fixed time step at a time — stopping the normal Scene clock and advancing exactly `1000 / fps` ms per frame — then capture the canvas as PNG frames and pipe them to FFmpeg for H.264 MP4 encoding. It is a standalone tool package: it depends on Puppeteer, Vite, and FFmpeg rather than on other `@vectojs/*` packages, so any project (or CI job) can render VectoJS animation time reproducibly.

## Install

```bash
bun add @vectojs/video-exporter
```

Requires FFmpeg with the `libx264` encoder as `ffmpeg` on `PATH`, plus Chromium resolved from `PUPPETEER_EXECUTABLE_PATH`, then `/usr/bin/chromium`, then Puppeteer's configured or bundled browser. Vite is installed automatically as a runtime dependency for local entries.

## Usage

```ts
// In the exported page: expose a startable Scene as window.vectoScene.
const scene = new Scene(document.querySelector('canvas')!);
window.vectoScene = scene;
scene.start();

// From Node/Bun:
import { exportVideo } from '@vectojs/video-exporter';

await exportVideo({
  url: './my-animation.ts', // local module or HTTP(S) URL
  outputPath: './out.mp4',
  width: 1920,
  height: 1080,
  fps: 60,
  duration: 10,
});
```

The fixed-step contract makes VectoJS animation time deterministic: the exporter calls the optional `reset()` on `window.vectoScene` right after stopping the clock (so scenes carrying load-time wall-clock state return to their t=0 presentation), then steps and captures `Math.ceil(fps * duration)` frames. Application code using unrelated clocks, network input, or unseeded randomness can still vary.

## Highlights

- Fixed-step scene control — `scene.step(1000 / fps)` before each capture, never wall-clock time; output is standard H.264 `yuv420p` MP4.
- CLI accepts a local JavaScript/TypeScript module (served through an in-memory Vite route that writes nothing into your source directory) or an already-hosted URL: `bunx vecto-export ./scene.ts -o out.mp4 -w 1920 -h 1080 -f 60 -d 5`.
- Atomic output: FFmpeg encodes to a unique staged file beside the destination, which replaces the target only after a successful exit; failed or aborted exports preserve any existing file and remove the staged one.
- Errors identify the failing phase — validation/Vite, Chromium/page contract, capture, FFmpeg spawn/stdin/exit, output commit, cleanup — with a bounded FFmpeg stderr tail attached.
- Cancellation end to end: `AbortSignal` on API exports, SIGINT/SIGTERM mapped to the same path in the CLI (exit codes 130/143); every acquired resource is released in reverse order.
- The Chromium sandbox stays enabled for normal users and is disabled only for root or with explicit `VECTO_CHROMIUM_NO_SANDBOX=1`, warning either way.
- Frame-0 determinism support (#646): page load free-runs rAF before capture begins, so scenes with load-time state should expose `reset()`; static-until-first-step scenes need nothing.

> Documents @vectojs/video-exporter@0.2.4.

## Documentation

- [`video-exporter` reference](https://vectojs.org/reference/video-exporter/)
