// G2 integrated browser confirmation: the REAL Scene._tickBatchedDrivers path
// (gather live SpringDriver/TweenDriver state -> wasm kernel -> scatter back via
// syncExternal + _applyDriverTick), not the isolated anim.rs kernel already
// measured in benchmarks/anim-wasm. That spike measured kernel-only cost with
// synthetic data written directly into wasm memory — no JS-side gather/scatter,
// no Entity/driver objects at all. Per the G3 lesson (an isolated kernel's
// verdict inverted once the integrated gather/scatter cost was measured), this
// is the number that actually decides Scene.animDriverGateCount.
//
// Two measurements:
//   1. Correctness: a real Scene+Entity tree, ticked via the actual scene.loop()
//      render path (not a direct method call), comparing wasm-batched results
//      against a parallel JS-only scene with identical seeds.
//   2. Performance: direct calls to the same per-frame mechanism Scene.render()
//      invokes — Entity.update() (JS path) vs Scene._tickBatchedDrivers (wasm
//      path) — bypassing render()/loop() entirely so neither measurement is
//      polluted by draw/a11y-sync cost that happens regardless of animation
//      (same reasoning as scene-hit-wasm's minMsWithSetup). A single AnimBackend
//      is instantiated once and reused across every wasm trial (it holds no
//      scene-specific state — Scene._tickBatchedDrivers gathers fresh input
//      every call — so sharing it just avoids re-instantiating the module).
//
// Every trial reseeds a fresh scene+drivers (same convention as the anim-wasm
// spike) rather than reusing one scene across trials, so a completed-and-
// removed driver from an earlier trial's iterations never lets a later trial
// silently measure fewer active drivers than the cell claims — decay-within-a-
// trial is bounded and identical between JS/wasm since both draw from the same
// seed. Posts JSON to /results (hyprland-browser-bench contract).
import { Scene, Entity } from '@vectojs/core';
import { instantiateSync, type AnimBackend } from '../../packages/core/src/wasm/anim-backend';

const p = new URLSearchParams(location.search);
const NS = (p.get('ns') ?? '8,16,32,64,128,256,512,1024,4096,16384').split(',').map(Number);
const KINDS = (p.get('kinds') ?? 'spring,tween,mixed').split(',') as (
  | 'spring'
  | 'tween'
  | 'mixed'
)[];
const ITERS = Number(p.get('iters') ?? 60); // steps per trial, matches the spike
const TRIALS = Number(p.get('trials') ?? 10);

class Box extends Entity {
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0x100000000);
}

function sceneWith(): Scene {
  const canvas = document.createElement('canvas');
  canvas.width = 400;
  canvas.height = 300;
  const scene = new Scene(canvas);
  (scene as unknown as { isRunning: boolean }).isRunning = true;
  scene.maxFPS = 0; // uncapped: every loop() call genuinely renders (correctness check only)
  return scene;
}

/** Build `n` entities with an active x-driver each. `seed` is drawn from the
 *  SAME `rng(seed)` sequence for both the JS-only and wasm-batched scene a
 *  caller compares, so the two are configured with identical params
 *  (stiffness/damping/mass or duration) — a genuine apples-to-apples compare. */
function buildDrivers(
  scene: Scene,
  n: number,
  kind: 'spring' | 'tween' | 'mixed',
  seed: number,
): Box[] {
  const rand = rng(seed);
  const boxes: Box[] = [];
  for (let i = 0; i < n; i++) {
    const b = new Box(`e${i}`);
    const to = (rand() - 0.5) * 200;
    const useSpring = kind === 'spring' || (kind === 'mixed' && i % 2 === 0);
    if (useSpring) {
      const stiffness = 80 + rand() * 300;
      const damping = 5 + rand() * 25;
      const mass = 0.5 + rand() * 2;
      b.setTransition({ x: { stiffness, damping, mass } });
    } else {
      const duration = 200 + rand() * 800;
      b.setTransition({ x: { duration, easing: 'easeOutQuad' } });
    }
    scene.add(b);
    b.x = to; // spawns the driver via the configured transition
    boxes.push(b);
  }
  return boxes;
}

/** Min over TRIALS of the closure `setup()` returns, running `setup()` itself
 *  untimed immediately before each trial — mirrors scene-hit-wasm's
 *  minMsWithSetup so a per-trial reseed (fresh scene + n entities) never
 *  pollutes the measured tick cost. */
function minMsWithSetup(trials: number, setup: () => () => void): number {
  let best = Infinity;
  for (let t = 0; t < trials; t++) {
    const action = setup();
    const t0 = performance.now();
    action();
    const dt = performance.now() - t0;
    if (dt < best) best = dt;
  }
  return best;
}

function beacon(level: string, msg: string): void {
  try {
    navigator.sendBeacon('/log', JSON.stringify({ level, msg }));
  } catch {
    /* best effort */
  }
}
function engineTag(): string {
  const ua = navigator.userAgent;
  const ff = /Firefox\/(\d+)/.exec(ua);
  if (ff) return `Firefox${ff[1]}`;
  const cr = /Chrome\/(\d+)/.exec(ua);
  if (cr) return `Chrome${cr[1]}`;
  return 'unknown';
}

const status = document.createElement('h2');
status.id = 'status';
status.textContent = 'running anim-wasm-scene benchmark…';
document.body.appendChild(status);
window.addEventListener('error', (e) => beacon('error', `error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) =>
  beacon('error', `reject: ${String(e.reason)}`),
);

async function run(): Promise<void> {
  const bytes = await (await fetch('./vectojs_core.wasm')).arrayBuffer();
  const rows: Record<string, unknown>[] = [];
  let seedCounter = 0x1000;

  // Correctness first, once per kind — must pass before any performance
  // number from this build is trusted. Ticks through the REAL scene.loop()
  // render path (not the direct-call microbenchmark below).
  let totalMismatches = 0;
  for (const kind of KINDS) {
    const seed = seedCounter++;
    const jsScene = sceneWith();
    const jsBoxes = buildDrivers(jsScene, 200, kind, seed);

    const wasmScene = sceneWith();
    const wasmOk = await wasmScene.enableWasmAnimBatching(bytes.slice(0));
    wasmScene.animDriverGateCount = 1; // force the gate open regardless of n
    const wasmBoxes = buildDrivers(wasmScene, 200, kind, seed);

    let clock = 0;
    for (let f = 0; f < 40; f++) {
      clock += 16;
      (jsScene as unknown as { loop: (t: number) => void }).loop(clock);
      (wasmScene as unknown as { loop: (t: number) => void }).loop(clock);
    }
    let mismatches = 0;
    let maxDelta = 0;
    for (let i = 0; i < 200; i++) {
      const delta = Math.abs(jsBoxes[i].x - wasmBoxes[i].x);
      if (delta > 1e-3) mismatches++;
      if (delta > maxDelta) maxDelta = delta;
    }
    totalMismatches += mismatches;
    beacon(
      'info',
      `correctness ${kind}: wasmAvailable=${wasmOk} mismatches=${mismatches}/200 maxDelta=${maxDelta.toExponential(2)}`,
    );
    if (!wasmOk) beacon('error', `${kind}: wasm anim backend failed to instantiate`);
    if (mismatches > 0) beacon('error', `${kind}: ${mismatches}/200 wasm/js MISMATCH`);
  }

  // Performance: direct per-frame mechanism calls — Entity.update() (JS path)
  // vs Scene._tickBatchedDrivers (wasm path) — bypassing render()/loop()
  // entirely. One AnimBackend instantiated once and shared across every wasm
  // trial: it holds no scene-specific state (Scene._tickBatchedDrivers gathers
  // fresh input from the live driver objects every call), so reusing it just
  // avoids paying module instantiation TRIALS*NS.length*KINDS.length times.
  const sharedBackend: AnimBackend | null = instantiateSync(bytes.slice(0));
  if (!sharedBackend) beacon('error', 'instantiateSync(anim-backend) failed — aborting perf sweep');

  const dtMs = 1000 / 60;
  const timeBase = 1000;
  if (sharedBackend) {
    for (const kind of KINDS) {
      for (const n of NS) {
        const seed = seedCounter++;

        const jsMs = minMsWithSetup(TRIALS, () => {
          const scene = sceneWith();
          const boxes = buildDrivers(scene, n, kind, seed);
          let t = timeBase;
          return () => {
            for (let it = 0; it < ITERS; it++) {
              t += dtMs;
              for (let i = 0; i < n; i++) boxes[i].update(dtMs, t);
            }
          };
        });

        const wasmMs = minMsWithSetup(TRIALS, () => {
          const scene = sceneWith();
          scene.setAnimBackend(sharedBackend);
          scene.animDriverGateCount = 1; // force the gate open regardless of n
          buildDrivers(scene, n, kind, seed);
          const tickBatched = (
            scene as unknown as { _tickBatchedDrivers: (dt: number) => void }
          )._tickBatchedDrivers.bind(scene);
          return () => {
            for (let it = 0; it < ITERS; it++) tickBatched(dtMs);
          };
        });

        const jsNs = (jsMs / ITERS / n) * 1e6;
        const wasmNs = (wasmMs / ITERS / n) * 1e6;
        rows.push({
          kind,
          n,
          jsNsPerDriver: Number(jsNs.toFixed(3)),
          wasmNsPerDriver: Number(wasmNs.toFixed(3)),
          speedup: Number((jsNs / wasmNs).toFixed(2)),
        });
        beacon('info', `${kind} n=${n}: js=${jsNs.toFixed(2)}ns wasm=${wasmNs.toFixed(2)}ns`);
        status.textContent = `done ${rows.length}/${KINDS.length * NS.length}…`;
      }
    }
  }

  const report = {
    name: 'anim-wasm-scene',
    engine: engineTag(),
    userAgent: navigator.userAgent,
    crossOriginIsolated: self.crossOriginIsolated,
    iters: ITERS,
    trials: TRIALS,
    correctnessMismatches: totalMismatches,
    note: 'INTEGRATED cost via Entity.update()/Scene._tickBatchedDrivers directly (bypasses render()/loop() drawing cost) — includes gather+scatter, unlike benchmarks/anim-wasm which is kernel-only',
    rows,
  };
  (window as unknown as { __BENCH__?: unknown }).__BENCH__ = report;
  await fetch('/results', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(report),
  });
  status.textContent = `done: ${rows.length} cells posted — you can close this window`;
}

run().catch((e) => {
  status.textContent = 'error: ' + String(e);
  beacon('error', `run failed: ${String(e)}`);
});
