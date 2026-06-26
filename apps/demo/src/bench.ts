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
// `world=<k>` spreads entities across a k×viewport world (k>1 ⇒ most are
// off-screen) and gives each a getBounds(), exercising viewport culling.
const WORLD = Number(params.get('world') ?? 1);
// `batch=1` opts each circle into the renderer draw-call batching fast-path
// (getBatchCircle), coalescing same-color circles into a single fill().
// `backend=webgl` routes those circles to the WebGL2 point-cloud layer instead.
const BACKEND = params.get('backend') ?? 'canvas';
const WEBGL = BACKEND === 'webgl';
const BATCH = params.get('batch') === '1' || WEBGL;
// `sprite=1` experiment: blit a pre-rendered circle bitmap via drawImage
// (the canonical Canvas2D particle technique) instead of arc+fill.
const SPRITE = params.get('sprite') === '1';
// `shape=rect` benchmarks rectangles (GPU instanced quads on backend=webgl,
// else Canvas2D roundRect+fill per entity).
const SHAPE = params.get('shape') ?? 'circle';
const RECT = SHAPE === 'rect';

let spriteCanvas: HTMLCanvasElement | null = null;
function getSprite(radius: number): HTMLCanvasElement {
  if (spriteCanvas) return spriteCanvas;
  const s = document.createElement('canvas');
  const d = Math.ceil(radius * 2) + 2;
  s.width = d;
  s.height = d;
  const c = s.getContext('2d')!;
  c.beginPath();
  c.arc(d / 2, d / 2, radius, 0, Math.PI * 2);
  c.fillStyle = '#38bdf8';
  c.fill();
  spriteCanvas = s;
  return s;
}

class BenchCircle extends Entity {
  private radius: number;
  private culled: boolean;
  private batch: boolean;
  constructor(radius: number, culled: boolean, batch: boolean) {
    super();
    this.radius = radius;
    this.culled = culled;
    this.batch = batch;
  }
  isPointInside(): boolean {
    return false;
  }
  getBounds() {
    return this.culled
      ? { x: -this.radius, y: -this.radius, width: this.radius * 2, height: this.radius * 2 }
      : null;
  }
  getBatchCircle() {
    return this.batch && !RECT ? { radius: this.radius, color: '#38bdf8' } : null;
  }
  getBatchRect() {
    return this.batch && RECT
      ? { width: this.radius * 2, height: this.radius * 2, color: '#38bdf8' }
      : null;
  }
  render(r: IRenderer): void {
    if (RECT) {
      r.beginPath();
      r.roundRect(0, 0, this.radius * 2, this.radius * 2, 0);
      r.fill('#38bdf8');
      return;
    }
    if (SPRITE) {
      const d = Math.ceil(this.radius * 2) + 2;
      r.drawImage(getSprite(this.radius), -d / 2, -d / 2, d, d);
      return;
    }
    r.beginPath();
    r.arc(0, 0, this.radius, 0, Math.PI * 2);
    r.fill('#38bdf8');
  }
}

const app = document.getElementById('app')!;
const canvas = document.createElement('canvas');
app.appendChild(canvas);
const scene = new Scene(canvas, WEBGL ? { pointBackend: 'webgl' } : {});
// `render=onDemand` exercises the on-demand redraw path: a static scene renders
// once then idles, so frame cost should collapse regardless of N.
if (params.get('render') === 'onDemand') scene.renderMode = 'onDemand';

const W = window.innerWidth * WORLD;
const H = window.innerHeight * WORLD;
const cols = Math.max(1, Math.ceil(Math.sqrt(N * (W / H))));
const rows = Math.ceil(N / cols);
const cellW = W / cols;
const cellH = H / rows;

for (let i = 0; i < N; i++) {
  const col = i % cols;
  const row = Math.floor(i / cols);
  scene.add(
    new BenchCircle(Math.min(3, cellW / 2), WORLD > 1, BATCH).setPosition(
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
    // 2 canvases (2D + GL) ⇒ the WebGL point layer is actually active.
    glActive: WEBGL && app.querySelectorAll('canvas').length > 1,
  };
  (window as Window & { __BENCH_DONE__?: boolean }).__BENCH_DONE__ = true;
}

requestAnimationFrame(() => {
  last = performance.now();
  requestAnimationFrame(tick);
});
