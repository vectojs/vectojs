# @vectojs/video-exporter

An industrial-grade video exporter for VectoJS. Convert your VectoJS canvas animations, mathematical rendering, and physics simulations into flawless 60fps MP4 video streams.

## Features

- **Deterministic Rendering**: Hijacks the VectoJS internal clock for flawless `1/60s` frame stepping. Zero dropped frames, regardless of calculation complexity.
- **High-Performance Pipeline**: Uses Puppeteer to drive headless Chromium and streams raw Canvas buffers via CDP directly to FFmpeg.
- **Hardware/Software Encoding**: Encodes to standard H.264 MP4 directly via FFmpeg.
- **Zero Config TypeScript DX**: Pass a pure `.ts` or `.tsx` file, and the exporter will automatically spin up an embedded Vite server, wrap it in a Canvas context, and export it invisibly.

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
