# @vectojs/video-exporter

[![npm](https://img.shields.io/npm/v/@vectojs/video-exporter?color=22d3ee)](https://www.npmjs.com/package/@vectojs/video-exporter)
[![CI](https://github.com/vectojs/vectojs/actions/workflows/ci.yml/badge.svg)](https://github.com/vectojs/vectojs/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-6366f1.svg)](https://github.com/vectojs/vectojs/blob/main/LICENSE)

[Documentation](https://vectojs.xuepoo.xyz/reference/video-exporter/) ·
[Main repository](https://github.com/vectojs/vectojs)

Export a VectoJS canvas scene to a fixed-rate H.264 MP4. The exporter stops the page's normal
Scene clock, advances it by an exact `1000 / fps` milliseconds per frame, captures PNG frames in
Chromium, and streams them to FFmpeg.

## Requirements

- Node.js or Bun
- FFmpeg with the `libx264` encoder available as `ffmpeg` on `PATH`
- Chromium, resolved in this order:
  1. `PUPPETEER_EXECUTABLE_PATH`
  2. `/usr/bin/chromium` when it exists
  3. Puppeteer's configured or bundled browser

Install the package with your package manager:

```bash
bun add @vectojs/video-exporter
```

Vite is a runtime dependency and is installed automatically for local TypeScript and JavaScript
entry files.

## Scene contract

The rendered page must expose `window.vectoScene` with callable `stop()` and `step(dt)` methods. The
first `<canvas>` is resized to the requested output dimensions and captured. The output contract is
H.264 video with `yuv420p` pixel format in an MP4 container.

```typescript
const scene = new Scene(document.querySelector('canvas')!);
// Add entities before exposing the scene.
(window as Window & { vectoScene?: Scene }).vectoScene = scene;
scene.start();
```

Fixed steps make VectoJS animation time deterministic. Application code that uses wall-clock time,
unseeded randomness, network input, or other external state can still vary between exports.

## CLI

Pass a local JavaScript or TypeScript module:

```bash
bunx vecto-export ./my-animation.ts -o output.mp4 -w 1920 -h 1080 -f 60 -d 5
```

Or capture an already-hosted page:

```bash
bunx vecto-export http://localhost:5173 -o output.mp4 -f 60 -d 5
```

| Option           | Meaning                            | Default   |
| ---------------- | ---------------------------------- | --------- |
| `-o, --output`   | Output MP4 path                    | `out.mp4` |
| `-w, --width`    | Positive integer width             | `1280`    |
| `-h, --height`   | Positive integer height            | `720`     |
| `-f, --fps`      | Positive integer frames per second | `60`      |
| `-d, --duration` | Positive duration in seconds       | `5`       |

`SIGINT` and `SIGTERM` abort the active export, wait for Chromium, Vite, FFmpeg, progress output, and
staged files to be cleaned up, then return exit code 130 or 143 respectively.

## API

The 0.2 API remains compatible. `signal` is optional.

```typescript
import { exportVideo } from '@vectojs/video-exporter';

const controller = new AbortController();

await exportVideo({
  url: './my-animation.ts', // Local module or HTTP(S) URL
  outputPath: './out.mp4',
  width: 1920,
  height: 1080,
  fps: 60,
  duration: 10,
  signal: controller.signal,
});
```

The frame count is `Math.ceil(fps * duration)`. The Promise resolves only after FFmpeg exits
successfully and the staged MP4 replaces the destination. A failed or aborted export preserves an
existing destination and removes the incomplete staged file.

## Chromium sandbox policy

The sandbox remains enabled for normal users. It is disabled only when the process runs as root or
when `VECTO_CHROMIUM_NO_SANDBOX=1` is explicitly set; either case emits a warning. Prefer running the
exporter as a non-root user.

```bash
PUPPETEER_EXECUTABLE_PATH=/opt/chrome/chrome bunx vecto-export ./scene.ts
VECTO_CHROMIUM_NO_SANDBOX=1 bunx vecto-export ./scene.ts
```

## Failure behavior

Errors identify the phase that failed: input validation/Vite startup, Chromium launch or page
contract, canvas capture, FFmpeg spawn/stdin/exit, output commit, or cleanup. FFmpeg errors retain a
bounded stderr tail. If cleanup also fails, the original export error remains first in the attached
`AggregateError`.

Local entries are served from an in-memory Vite HTML route; the exporter does not write helper HTML
into the source directory. Every acquired resource is released in reverse order on success, error,
or abort.
