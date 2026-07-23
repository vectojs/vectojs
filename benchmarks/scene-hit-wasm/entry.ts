// G3 browser confirmation: the INTEGRATED Scene.findEntityAt, not the standalone
// hit.rs kernel (already benchmarked in benchmarks/hit-wasm). Since findEntityAt
// is called ad-hoc (hover/click), not every frame, this measures TWO realistic
// shapes, each isolating JUST the hit-test overhead by doing the render (which
// happens every frame regardless of hit-testing) as untimed SETUP before the
// timed region — conflating render cost into the query timing would misattribute
// the scene's own pre-existing draw/update cost to the G3 integration:
//   cold : one query per fresh render (pays the lazy grid rebuild every time —
//          the worst case, e.g. a single click handler)
//   warm : many queries against the SAME rendered frame, amortized (the grid
//          builds once — on the first query — then every additional query is
//          grid-only — e.g. hover-tracking or multiple hit-tests per frame)
// against the JS depth-first walk (findHitRecursively), on real Chrome/Firefox.
// Posts JSON to /results (hyprland-browser-bench contract).
import { Scene, Entity } from '@vectojs/core';

const p = new URLSearchParams(location.search);
const NS = (p.get('ns') ?? '1000,10000,100000').split(',').map(Number);
const WARM_QUERIES = Number(p.get('warm') ?? 200);
const TRIALS = Number(p.get('trials') ?? 10);

class Box extends Entity {
  width = 1;
  height = 1;
  constructor(
    id: string,
    public w: number,
    public h: number,
  ) {
    super(id);
    this.width = w;
    this.height = h;
  }
  getBounds() {
    return { x: 0, y: 0, width: this.w, height: this.h };
  }
  isPointInside(gx: number, gy: number): boolean {
    const local = this.worldToLocal(gx, gy);
    if (!local) return false;
    return local.x >= 0 && local.x <= this.w && local.y >= 0 && local.y <= this.h;
  }
  render(): void {}
}

const VW = 1280;
const VH = 800;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0x100000000);
}
function sceneWith(): Scene {
  const canvas = document.createElement('canvas');
  canvas.width = VW;
  canvas.height = VH;
  const scene = new Scene(canvas);
  (scene as unknown as { isRunning: boolean }).isRunning = true;
  // Outside a test environment Scene defaults to a 60fps frame-pacing cap
  // (`maxFPS=60`), which silently no-ops a loop() call arriving <16.67ms
  // after the last one — exactly what renderFrame() calls in this bench's
  // setup steps do. Uncapped is what "isTest" mode gets by default; force the
  // same here so every renderFrame() call genuinely re-renders (and so
  // genuinely invalidates the lazily-cached hit grid) instead of silently
  // skipping and leaving the previous grid/frame counter untouched.
  scene.maxFPS = 0;
  return scene;
}
function buildEntities(scene: Scene, n: number): void {
  const rand = rng(0xbeef);
  for (let i = 0; i < n; i++) {
    const w = 8 + rand() * 60;
    const h = 8 + rand() * 60;
    const e = new Box(`e${i}`, w, h);
    e.x = rand() * (VW + 200) - 100;
    e.y = rand() * (VH + 200) - 100;
    scene.add(e);
  }
}
/** Advance the scene's frame counter (a real render pass) so the lazily-cached
 *  hit grid is invalidated — mirrors what an actual new rendered frame does. */
function renderFrame(scene: Scene): void {
  (scene as unknown as { loop: (t: number) => void }).loop(performance.now());
}
/** Time `action(trialIndex)`, running untimed `setup` immediately before each
 *  trial — so a render inside `setup` (whose cost happens every frame
 *  regardless of hit-testing) never pollutes the measured hit-test cost.
 *  `action` receives the trial index so a single-query measurement can cycle
 *  through different query points per trial: `findHitRecursively` walks
 *  children in REVERSE order, so a fixed point that happens to land inside a
 *  high-index entity returns after one check — repeating the SAME point every
 *  trial would consistently hit that one lucky/unlucky landing rather than
 *  measuring a representative query. */
function minMsWithSetup(
  trials: number,
  setup: () => void,
  action: (trial: number) => void,
): number {
  let best = Infinity;
  for (let t = 0; t < trials; t++) {
    setup();
    const t0 = performance.now();
    action(t);
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
status.textContent = 'running scene-hit benchmark…';
document.body.appendChild(status);
window.addEventListener('error', (e) => beacon('error', `error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) =>
  beacon('error', `reject: ${String(e.reason)}`),
);

async function run(): Promise<void> {
  const bytes = await (await fetch('./vectojs_core.wasm')).arrayBuffer();
  const rows: Record<string, unknown>[] = [];

  // Fixed query points, shared across JS/wasm and across N for a fair compare.
  const q = rng(0xa11ce);
  const queryX: number[] = [];
  const queryY: number[] = [];
  for (let i = 0; i < Math.max(500, WARM_QUERIES); i++) {
    queryX.push(q() * VW);
    queryY.push(q() * VH);
  }
  const noop = () => {
    /* no render between trials */
  };

  for (const n of NS) {
    // JS-only baseline: single query, isolated (no render mixed in — JS has
    // no build step, so a fresh render vs. a stale one costs the same here).
    const jsScene = sceneWith();
    buildEntities(jsScene, n);
    renderFrame(jsScene);
    const jsColdMs = minMsWithSetup(
      TRIALS,
      () => renderFrame(jsScene),
      (t) => jsScene.findEntityAt(queryX[t], queryY[t]),
    );
    const jsColdNs = jsColdMs * 1e6;

    // WASM: same scene topology, hit-test backend enabled.
    const wasmScene = sceneWith();
    buildEntities(wasmScene, n);
    const wasmOk = await wasmScene.enableWasmHitTest(bytes.slice(0));
    renderFrame(wasmScene);

    // Correctness sanity check in the REAL engine (not just jsdom): the first
    // 200 query results must match a fresh JS-only scene with the same seed.
    const refScene = sceneWith();
    buildEntities(refScene, n);
    renderFrame(refScene);
    let mismatches = 0;
    for (let i = 0; i < 200; i++) {
      const a = refScene.findEntityAt(queryX[i], queryY[i])?.id ?? null;
      const b = wasmScene.findEntityAt(queryX[i], queryY[i])?.id ?? null;
      if (a !== b) mismatches++;
    }
    if (mismatches > 0) beacon('error', `n=${n}: ${mismatches}/200 wasm/js MISMATCH`);

    // cold: fresh render (untimed setup) then exactly ONE query — pure
    // gather+build+query cost, the worst case (one query per rendered frame).
    const wasmColdMs = minMsWithSetup(
      TRIALS,
      () => renderFrame(wasmScene),
      (t) => wasmScene.findEntityAt(queryX[t], queryY[t]),
    );
    const wasmColdNs = wasmColdMs * 1e6;

    // warm: fresh render (untimed setup) then WARM_QUERIES queries — the
    // first pays gather+build, the rest are grid-query-only; per-query cost
    // amortizes that one-time build over the batch (repeated hit-tests
    // against the same rendered frame, e.g. hover-tracking).
    const wasmWarmMs = minMsWithSetup(
      TRIALS,
      () => renderFrame(wasmScene),
      () => {
        for (let i = 0; i < WARM_QUERIES; i++) wasmScene.findEntityAt(queryX[i], queryY[i]);
      },
    );
    const wasmWarmPerQueryNs = (wasmWarmMs / WARM_QUERIES) * 1e6;

    // hot: fresh render + one query as UNTIMED setup (pays gather+build, result
    // discarded), THEN time a batch of subsequent queries alone — isolates the
    // steady-state per-query cost once this frame's grid already exists, fully
    // decoupled from build cost (unlike "warm", which is still build-dominated
    // at high N since WARM_QUERIES isn't large enough to amortize a ~10ms
    // build down to negligible — this is the fair comparison to jsSteady).
    const wasmHotMs = minMsWithSetup(
      TRIALS,
      () => {
        renderFrame(wasmScene);
        wasmScene.findEntityAt(queryX[0], queryY[0]); // pays the build; discarded
      },
      () => {
        for (let i = 0; i < WARM_QUERIES; i++) wasmScene.findEntityAt(queryX[i], queryY[i]);
      },
    );
    const wasmHotPerQueryNs = (wasmHotMs / WARM_QUERIES) * 1e6;

    // js steady-state per-query (repeated queries, no render between —
    // confirms jsColdNs is representative: JS has no cold/warm distinction).
    const jsSteadyMs = minMsWithSetup(TRIALS, noop, () => {
      for (let i = 0; i < 500; i++) jsScene.findEntityAt(queryX[i], queryY[i]);
    });
    const jsSteadyNs = (jsSteadyMs / 500) * 1e6;

    rows.push({
      n,
      wasmAvailable: wasmOk,
      mismatches,
      jsColdNsPerQuery: Number(jsColdNs.toFixed(1)),
      jsSteadyNsPerQuery: Number(jsSteadyNs.toFixed(1)),
      wasmColdNsPerQuery: Number(wasmColdNs.toFixed(1)),
      wasmWarmNsPerQuery: Number(wasmWarmPerQueryNs.toFixed(1)),
      wasmHotNsPerQuery: Number(wasmHotPerQueryNs.toFixed(1)),
      coldSpeedup: Number((jsColdNs / wasmColdNs).toFixed(2)),
      warmSpeedup: Number((jsSteadyNs / wasmWarmPerQueryNs).toFixed(2)),
      hotSpeedup: Number((jsSteadyNs / wasmHotPerQueryNs).toFixed(2)),
    });
    beacon(
      'info',
      `n=${n}: jsCold=${jsColdNs.toFixed(0)}ns jsSteady=${jsSteadyNs.toFixed(0)}ns wasmCold=${wasmColdNs.toFixed(0)}ns wasmWarm=${wasmWarmPerQueryNs.toFixed(0)}ns wasmHot=${wasmHotPerQueryNs.toFixed(0)}ns mismatches=${mismatches}`,
    );
    status.textContent = `done ${rows.length}/${NS.length}…`;
  }

  const report = {
    name: 'scene-hit-wasm',
    engine: engineTag(),
    userAgent: navigator.userAgent,
    crossOriginIsolated: self.crossOriginIsolated,
    warmQueries: WARM_QUERIES,
    trials: TRIALS,
    note: 'render cost is untimed setup, isolating pure hit-test overhead; cold = one query per fresh render (pays lazy grid rebuild); warm = amortized over WARM_QUERIES against one build; hot = steady-state per-query with the build cost excluded entirely (fair vs jsSteady)',
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
