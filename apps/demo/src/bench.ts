import { Scene, Entity, type IRenderer } from '@vecto-ui/core';

/**
 * Headless rendering benchmark page.
 *
 * Spawns N entities into a {@link Scene}, runs the real render loop, and measures
 * achieved frame intervals (Scene re-renders every entity each frame — no dirty
 * checking). Results are published on `window.__BENCH__` for the Playwright driver
 * in `scripts/benchmark.ts`. Launch Chrome with frame-rate limiting disabled to
 * read true per-frame render cost instead of the 60 Hz vsync cap.
 */

const params = new URLSearchParams(location.search);
const N = Number(params.get('n') ?? 10_000);
const FRAMES = Number(params.get('frames') ?? 120);
const WARMUP = Number(params.get('warmup') ?? 30);

class BenchCircle extends Entity {
  private radius: number;
  constructor(radius: number) {
    super();
    this.radius = radius;
  }
  isPointInside(): boolean {
    return false;
  }
  render(r: IRenderer): void {
    r.beginPath();
    r.arc(0, 0, this.radius, 0, Math.PI * 2);
    r.fill('#38bdf8');
  }
}

const app = document.getElementById('app')!;
const canvas = document.createElement('canvas');
app.appendChild(canvas);
const scene = new Scene(canvas);

const W = window.innerWidth;
const H = window.innerHeight;
const cols = Math.max(1, Math.ceil(Math.sqrt(N * (W / H))));
const rows = Math.ceil(N / cols);
const cellW = W / cols;
const cellH = H / rows;

for (let i = 0; i < N; i++) {
  const col = i % cols;
  const row = Math.floor(i / cols);
  scene.add(
    new BenchCircle(Math.min(3, cellW / 2)).setPosition(
      col * cellW + cellW / 2,
      row * cellH + cellH / 2,
    ),
  );
}

scene.start();

// Measure frame intervals from a sibling rAF loop running alongside Scene's loop.
const samples: number[] = [];
let last = performance.now();
let warmupLeft = WARMUP;

function tick(): void {
  const now = performance.now();
  const dt = now - last;
  last = now;

  if (warmupLeft > 0) {
    warmupLeft--;
  } else {
    samples.push(dt);
  }

  if (samples.length < FRAMES) {
    requestAnimationFrame(tick);
    return;
  }

  scene.stop();
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;

  (window as Window & { __BENCH__?: unknown; __BENCH_DONE__?: boolean }).__BENCH__ = {
    n: N,
    frames: samples.length,
    meanMs: Number(mean.toFixed(3)),
    p50Ms: Number(pick(0.5).toFixed(3)),
    p95Ms: Number(pick(0.95).toFixed(3)),
    maxFps: Number((1000 / mean).toFixed(1)),
    sustains60: mean <= 1000 / 60,
  };
  (window as Window & { __BENCH_DONE__?: boolean }).__BENCH_DONE__ = true;
}

requestAnimationFrame(() => {
  last = performance.now();
  requestAnimationFrame(tick);
});
