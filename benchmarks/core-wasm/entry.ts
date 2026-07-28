// In-browser benchmark entry: WASM f64x2 SIMD vs the JS reference composer over
// the same SoA store. Runs the full sweep itself and POSTs the result array to
// /results (the hyprland-browser-bench contract), so it is driven by a REAL
// browser foregrounded on a dedicated workspace — never a Playwright-controlled
// build, whose patched Firefox runs wasm in a non-optimizing tier and reported
// this kernel 3-5x SLOWER than stock Gecko does. Real browsers only.
//
// Two WASM costs are reported per cell:
//   - copy:     upload + kernel + readback every frame (naive integration).
//   - resident: kernel only, inputs/outputs already in wasm memory (the DESIGNED
//               integration — accessors write inputs in place, the renderer
//               reads world matrices from the view; no per-frame batch copy).
// The resident number is the fair comparison for what Phase 1 will actually pay.
import {
  buildStore,
  composeJS,
  computeAabbsJS,
  type InputNode,
  type TransformStore,
} from '@core/soa';
import { instantiateAsync, type WasmTransformBackend } from '@core/backend';
import { awaitStart, reportFailure, reportResult } from '../_shared/client.ts';

type Topo = 'flat' | 'chain' | 'bushy' | 'mixed';

const p = new URLSearchParams(location.search);
const NS = (p.get('ns') ?? '1000,10000,100000').split(',').map(Number);
const TOPOS = (p.get('topos') ?? 'flat,chain,bushy').split(',') as Topo[];
const ITERS = Number(p.get('iters') ?? 200);
const TRIALS = Number(p.get('trials') ?? 12);

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0x100000000);
}
function randomTree(count: number, topo: Topo, rand: () => number): InputNode[] {
  const nodes: InputNode[] = [];
  for (let k = 0; k < count; k++) {
    let parent: number;
    if (k === 0) parent = -1;
    else if (topo === 'flat') parent = 0;
    else if (topo === 'chain') parent = k - 1;
    else if (topo === 'bushy') parent = Math.floor(rand() * k);
    else parent = rand() < 0.5 ? 0 : Math.floor(rand() * k);
    nodes.push({
      parent,
      x: (rand() - 0.5) * 2000,
      y: (rand() - 0.5) * 2000,
      scaleX: 0.25 + rand() * 3,
      scaleY: 0.25 + rand() * 3,
      rotation: (rand() - 0.5) * Math.PI * 4,
      opacity: rand(),
      bw: rand() * 300,
      bh: rand() * 200,
    });
  }
  return nodes;
}
function minMs(fn: () => void): number {
  let best = Infinity;
  for (let t = 0; t < TRIALS; t++) {
    const t0 = performance.now();
    fn();
    const dt = performance.now() - t0;
    if (dt < best) best = dt;
  }
  return best;
}
function bitIdentical(a: TransformStore, b: TransformStore): boolean {
  for (let i = 0; i < a.count; i++) {
    if (
      !Object.is(a.wa[i], b.wa[i]) ||
      !Object.is(a.wb[i], b.wb[i]) ||
      !Object.is(a.wc[i], b.wc[i]) ||
      !Object.is(a.wd[i], b.wd[i]) ||
      !Object.is(a.we[i], b.we[i]) ||
      !Object.is(a.wf[i], b.wf[i]) ||
      !Object.is(a.wo[i], b.wo[i])
    ) {
      return false;
    }
  }
  return true;
}
const round = (v: number, d = 3): number => Number(v.toFixed(d));

function cell(
  backend: WasmTransformBackend | null,
  n: number,
  topo: Topo,
): Record<string, unknown> {
  const nodes = randomTree(n, topo, rng(n * 31 + topo.length));
  const jsStore = buildStore(nodes);
  const wasmStore = buildStore(nodes);

  let identical = true;
  if (backend) {
    composeJS(jsStore);
    backend.compose(wasmStore, 'simd');
    identical = bitIdentical(jsStore, wasmStore);
    backend.uploadRuns(wasmStore); // prime resident model
  }

  for (let i = 0; i < 20; i++) composeJS(jsStore);
  if (backend)
    for (let i = 0; i < 20; i++) {
      backend.compose(wasmStore, 'simd');
      backend.runKernel('simd');
    }

  const jsMs = minMs(() => {
    for (let i = 0; i < ITERS; i++) composeJS(jsStore);
  });
  const copyMs = backend
    ? minMs(() => {
        for (let i = 0; i < ITERS; i++) backend.compose(wasmStore, 'simd');
      })
    : NaN;
  const residentMs = backend
    ? minMs(() => {
        for (let i = 0; i < ITERS; i++) backend.runKernel('simd');
      })
    : NaN;

  // G1+ world-AABB pass: JS 4-corner transform vs the resident WASM kernel
  // (world matrices + bounds already in wasm memory). Compose once so the world
  // matrices the AABB pass reads are populated for both sides.
  composeJS(jsStore);
  computeAabbsJS(jsStore);
  if (backend) {
    backend.runKernel('simd');
    // prime resident bounds so runAabbs reads real boxes
    const bV = backend.boundsView();
    for (let i = 0; i < wasmStore.count; i++) {
      bV.bx[i] = wasmStore.bx[i];
      bV.by[i] = wasmStore.by[i];
      bV.bw[i] = wasmStore.bw[i];
      bV.bh[i] = wasmStore.bh[i];
    }
    for (let i = 0; i < 20; i++) backend.runAabbs(wasmStore.count);
  }
  const jsAabbMs = minMs(() => {
    for (let i = 0; i < ITERS; i++) computeAabbsJS(jsStore);
  });
  const wasmAabbMs = backend
    ? minMs(() => {
        for (let i = 0; i < ITERS; i++) backend.runAabbs(wasmStore.count);
      })
    : NaN;

  const per = (ms: number) => (ms / ITERS / n) * 1e6; // ns/entity/frame
  const js = per(jsMs);
  const copy = per(copyMs);
  const resident = per(residentMs);
  const jsAabb = per(jsAabbMs);
  const wasmAabb = per(wasmAabbMs);
  return {
    n,
    topo,
    identical,
    jsNsPerEntity: round(js, 2),
    copyNsPerEntity: round(copy, 2),
    residentNsPerEntity: round(resident, 2),
    copySpeedup: round(js / copy),
    residentSpeedup: round(js / resident),
    jsAabbNsPerEntity: round(jsAabb, 2),
    wasmAabbNsPerEntity: round(wasmAabb, 2),
    aabbSpeedup: round(jsAabb / wasmAabb),
  };
}

/** Short engine label for the results filename (Firefox152 / Chrome150). */
function engineTag(): string {
  const ua = navigator.userAgent;
  const ff = /Firefox\/(\d+)/.exec(ua);
  if (ff) return `Firefox${ff[1]}`;
  const cr = /Chrome\/(\d+)/.exec(ua);
  if (cr) return `Chrome${cr[1]}`;
  return 'unknown';
}

function beacon(level: string, msg: string): void {
  try {
    navigator.sendBeacon('/log', JSON.stringify({ level, msg }));
  } catch {
    /* best-effort progress log */
  }
}

async function run(): Promise<void> {
  await awaitStart();
  const startedAt = performance.now();
  beacon('info', `start ${engineTag()} topos=${TOPOS} ns=${NS}`);
  const bytes = await (await fetch('./vectojs_core.wasm')).arrayBuffer();
  const backend = await instantiateAsync(bytes);
  beacon('info', `wasm available=${!!backend}`);

  const rows: Record<string, unknown>[] = [];
  for (const topo of TOPOS) {
    for (const n of NS) {
      rows.push(cell(backend, n, topo));
      beacon('info', `done ${topo} n=${n} (${rows.length}/${TOPOS.length * NS.length})`);
      status.textContent = `benchmark: ${rows.length}/${TOPOS.length * NS.length} cells…`;
    }
  }

  // `iters`/`trials` move into `params` (workload dimensions); `wasmAvailable` is
  // a validation fact about the run, so it goes in `summary`. `hardwareConcurrency`
  // and `crossOriginIsolated` are dropped here because the envelope's `browser`
  // block already carries both.
  const report = await reportResult({
    name: 'core-wasm',
    params: { iters: ITERS, trials: TRIALS },
    summary: { wasmAvailable: !!backend },
    rows,
    durationMs: +(performance.now() - startedAt).toFixed(1),
    // Without the backend the wasm columns are all NaN, so the run cannot answer
    // the question it exists to answer.
    issues: backend ? [] : ['wasm backend unavailable: every wasm column is NaN'],
  });
  (window as unknown as { __BENCH__?: unknown; __BENCH_DONE__?: boolean }).__BENCH__ = report;
  (window as unknown as { __BENCH_DONE__?: boolean }).__BENCH_DONE__ = true;
  status.textContent = `done: ${rows.length} cells posted — you can close this window`;
}

// Status lives in its own element so per-cell text updates never destroy sibling
// content (a skill gotcha: writing textContent wipes children).
const status = document.createElement('h2');
status.id = 'status';
status.textContent = 'running benchmark…';
document.body.appendChild(status);

window.addEventListener('error', (e) => beacon('error', `error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) =>
  beacon('error', `reject: ${String(e.reason)}`),
);

run().catch((error) => {
  status.textContent = 'error: ' + String(error);
  beacon('error', `run failed: ${String(error)}`);
  // The beacon only reaches the server log. Without this the page never POSTs
  // anything, so a thrown run is indistinguishable from a hang and burns the
  // runner's full timeout; `reportFailure` posts a complete `failed: true`
  // envelope instead.
  void reportFailure('core-wasm', error);
});
