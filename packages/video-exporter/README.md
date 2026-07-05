# @vectojs/video-exporter

Export VectoJS canvas animations, mathematical rendering, and physics simulations to a fixed-rate
H.264 MP4 file.

## Features

- **Fixed-step rendering**: Calls `window.vectoScene.step(1000 / fps)` once for every output frame,
  so output timing does not depend on wall-clock rendering speed.
- **PNG-to-FFmpeg pipeline**: Captures the first canvas as PNG data, then writes each frame to an
  FFmpeg process in sequence.
- **Standard MP4 output**: Encodes H.264 with FFmpeg's `libx264` encoder and `yuv420p` pixel format.
- **TypeScript entry support**: A `.ts` or `.tsx` input is served by an embedded Vite process before
  capture; an already-hosted HTTP URL can be captured directly.

## Installation

```bash
bun add @vectojs/video-exporter
```

## Usage (CLI)

Pass a TypeScript file directly (Zero Config):

```bash
bunx vecto-export ./my-animation.ts -o output.mp4 -f 60 -d 5
```

Or pass a pre-hosted URL:

```bash
bunx vecto-export http://localhost:5173 -o output.mp4 -f 60 -d 5
```

### Options:

- `-o, --output` : Output file (default: out.mp4)
- `-w, --width` : Width in pixels (default: 1280)
- `-h, --height` : Height in pixels (default: 720)
- `-f, --fps` : Frames per second (default: 60)
- `-d, --duration`: Duration in seconds (default: 5)

## Internal API Usage

```typescript
import { exportVideo } from '@vectojs/video-exporter';

await exportVideo({
  url: 'my-animation.ts', // or a http URL
  outputPath: 'out.mp4',
  width: 1920,
  height: 1080,
  fps: 60,
  duration: 10,
});
```

_Note: The code being rendered must expose the VectoJS Scene globally as `window.vectoScene` for the exporter to hijack the clock._
