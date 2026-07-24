// In-browser f32-vs-f64 SIMD evaluation. Answers the standing TODO: does an
// f32x4 compose kernel (4 lanes) beat the shipped f64x2 one (2 lanes) enough to
// justify a lower-precision path? Driven by a REAL browser foregrounded on a
// dedicated workspace (hyprland-browser-bench contract) — never headless, whose
// non-optimizing wasm tier lies about kernel cost.
//
// Both kernels are measured RESIDENT (kernel-only, inputs/outputs already in
// wasm memory) — the fair comparison, isolating lane width + f32/f64 load-store
// bandwidth from the per-frame upload cost that would dominate otherwise.
//
// Also reports maxAbsErr / maxRelErr of f32 output vs the f64 reference, to put
// a number on the precision the 4-lane path would cost.
import { buildStore, type InputNode } from '@core/soa';

type Topo = 'flat' | 'chain' | 'bushy';

const p = new URLSearchParams(location.search);
const NS = (p.get('ns') ?? '1000,10000,100000').split(',').map(Number);
const TOPOS = (p.get('topos') ?? 'flat,chain,bushy').split(',') as Topo[];
const ITERS = Number(p.get('iters') ?? 200);
const TRIALS = Number(p.get('trials') ?? 12);

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
function randomTree(count: number, topo: Topo, rand: () => number): InputNode[] {
  const nodes: InputNode[] = [];
  for (let k = 0; k < count; k++) {
    let parent: number;
    if (k === 0) parent = -1;
    else if (topo === 'flat') parent = 0;
    else if (topo === 'chain') parent = k - 1;
    else parent = Math.floor(rand() * k);
    nodes.push({
      parent,
      x: (rand() - 0.5) * 2000,
      y: (rand() - 0.5) * 2000,
      scaleX: 0.25 + rand() * 3,
      scaleY: 0.25 + rand() * 3,
      rotation: (rand() - 0.5) * Math.PI * 4,
      opacity: rand(),
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
const round = (v: number, d = 3): number => Number(v.toFixed(d));

/** The raw C ABI: both the shipped f64 exports and the bench-only f32 ones. */
interface Exports {
  memory: WebAssembly.Memory;
  init(capacity: number, maxRuns: number): void;
  set_run_count(n: number): void;
  compose_simd(): void;
  p_x(): number;
  p_y(): number;
  p_sx(): number;
  p_sy(): number;
  p_cos(): number;
  p_sin(): number;
  p_opacity(): number;
  p_wa(): number;
  p_wb(): number;
  p_wc(): number;
  p_wd(): number;
  p_we(): number;
  p_wf(): number;
  p_wo(): number;
  p_run_parent(): number;
  p_run_start(): number;
  p_run_len(): number;
  init_f32(capacity: number, maxRuns: number): void;
  set_run_count_f32(n: number): void;
  compose_simd_f32(): void;
  p_f32_x(): number;
  p_f32_y(): number;
  p_f32_sx(): number;
  p_f32_sy(): number;
  p_f32_cos(): number;
  p_f32_sin(): number;
  p_f32_opacity(): number;
  p_f32_wa(): number;
  p_f32_wb(): number;
  p_f32_wc(): number;
  p_f32_wd(): number;
  p_f32_we(): number;
  p_f32_wf(): number;
  p_f32_wo(): number;
  p_f32_run_parent(): number;
  p_f32_run_start(): number;
  p_f32_run_len(): number;
}

function beacon(level: string, msg: string): void {
  try {
    navigator.sendBeacon('/log', JSON.stringify({ level, msg }));
  } catch {
    /* best-effort */
  }
}

/** One measurement cell: build the tree, upload to both stores, verify the f32
 *  output tracks f64, then time both resident kernels. */
function cell(ex: Exports, n: number, topo: Topo): Record<string, unknown> {
  const nodes = randomTree(n, topo, rng(n * 31 + topo.length));
  const store = buildStore(nodes);
  const cap = store.count;
  const runs = store.runCount;

  // --- f64 store upload ---
  ex.init(cap, runs);
  const f64buf = ex.memory.buffer;
  const F64 = (ptr: number) => new Float64Array(f64buf, ptr, cap);
  F64(ex.p_x()).set(store.x.subarray(0, cap));
  F64(ex.p_y()).set(store.y.subarray(0, cap));
  F64(ex.p_sx()).set(store.sx.subarray(0, cap));
  F64(ex.p_sy()).set(store.sy.subarray(0, cap));
  F64(ex.p_cos()).set(store.cos.subarray(0, cap));
  F64(ex.p_sin()).set(store.sin.subarray(0, cap));
  F64(ex.p_opacity()).set(store.opacity.subarray(0, cap));
  new Int32Array(f64buf, ex.p_run_parent(), runs).set(store.runParent.subarray(0, runs));
  new Int32Array(f64buf, ex.p_run_start(), runs).set(store.runStart.subarray(0, runs));
  new Int32Array(f64buf, ex.p_run_len(), runs).set(store.runLen.subarray(0, runs));
  ex.set_run_count(runs);

  // --- f32 store upload (init_f32 may grow memory; re-view after) ---
  ex.init_f32(cap, runs);
  const b = ex.memory.buffer;
  const F32 = (ptr: number) => new Float32Array(b, ptr, cap);
  F32(ex.p_f32_x()).set(store.x.subarray(0, cap));
  F32(ex.p_f32_y()).set(store.y.subarray(0, cap));
  F32(ex.p_f32_sx()).set(store.sx.subarray(0, cap));
  F32(ex.p_f32_sy()).set(store.sy.subarray(0, cap));
  F32(ex.p_f32_cos()).set(store.cos.subarray(0, cap));
  F32(ex.p_f32_sin()).set(store.sin.subarray(0, cap));
  F32(ex.p_f32_opacity()).set(store.opacity.subarray(0, cap));
  new Int32Array(b, ex.p_f32_run_parent(), runs).set(store.runParent.subarray(0, runs));
  new Int32Array(b, ex.p_f32_run_start(), runs).set(store.runStart.subarray(0, runs));
  new Int32Array(b, ex.p_f32_run_len(), runs).set(store.runLen.subarray(0, runs));
  ex.set_run_count_f32(runs);

  // Compose once with each; measure f32's divergence from the f64 reference.
  ex.compose_simd();
  ex.compose_simd_f32();
  const bb = ex.memory.buffer; // both stores now resident; re-view once
  const f64wa = new Float64Array(bb, ex.p_wa(), cap);
  const f64we = new Float64Array(bb, ex.p_we(), cap);
  const f32wa = new Float32Array(bb, ex.p_f32_wa(), cap);
  const f32we = new Float32Array(bb, ex.p_f32_we(), cap);
  let maxAbsErr = 0;
  let maxRelErr = 0;
  for (let i = 0; i < cap; i++) {
    for (const [ref, got] of [
      [f64wa[i]!, f32wa[i]!],
      [f64we[i]!, f32we[i]!],
    ] as const) {
      const abs = Math.abs(ref - got);
      if (abs > maxAbsErr) maxAbsErr = abs;
      const rel = Math.abs(ref) > 1e-9 ? abs / Math.abs(ref) : 0;
      if (rel > maxRelErr) maxRelErr = rel;
    }
  }

  // Warm both tiers before timing.
  for (let i = 0; i < 20; i++) ex.compose_simd();
  for (let i = 0; i < 20; i++) ex.compose_simd_f32();

  const f64Ms = minMs(() => {
    for (let i = 0; i < ITERS; i++) ex.compose_simd();
  });
  const f32Ms = minMs(() => {
    for (let i = 0; i < ITERS; i++) ex.compose_simd_f32();
  });

  const per = (ms: number) => (ms / ITERS / n) * 1e6; // ns/entity/frame
  const f64ns = per(f64Ms);
  const f32ns = per(f32Ms);
  return {
    n,
    topo,
    f64x2NsPerEntity: round(f64ns, 2),
    f32x4NsPerEntity: round(f32ns, 2),
    f32Speedup: round(f64ns / f32ns),
    maxAbsErr: round(maxAbsErr, 6),
    maxRelErr: round(maxRelErr, 9),
  };
}

function engineTag(): string {
  const ua = navigator.userAgent;
  const ff = /Firefox\/(\d+)/.exec(ua);
  if (ff) return `Firefox${ff[1]}`;
  const cr = /Chrome\/(\d+)/.exec(ua);
  if (cr) return `Chrome${cr[1]}`;
  return 'unknown';
}

async function run(): Promise<void> {
  beacon('info', `start ${engineTag()} topos=${TOPOS} ns=${NS}`);
  const bytes = await (await fetch('./vectojs_core.wasm')).arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports as unknown as Exports;

  const rows: Record<string, unknown>[] = [];
  for (const topo of TOPOS) {
    for (const n of NS) {
      rows.push(cell(ex, n, topo));
      beacon('info', `done ${topo} n=${n} (${rows.length}/${TOPOS.length * NS.length})`);
      status.textContent = `f32 eval: ${rows.length}/${TOPOS.length * NS.length} cells…`;
    }
  }

  const report = {
    name: 'f32-simd-eval',
    engine: engineTag(),
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    crossOriginIsolated: self.crossOriginIsolated,
    iters: ITERS,
    trials: TRIALS,
    rows,
  };
  (window as unknown as { __BENCH__?: unknown }).__BENCH__ = report;
  await fetch('/results', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(report),
  });
  (window as unknown as { __BENCH_DONE__?: boolean }).__BENCH_DONE__ = true;
  status.textContent = `done: ${rows.length} cells posted — you can close this window`;
}

const status = document.createElement('h2');
status.id = 'status';
status.textContent = 'running f32-simd-eval…';
document.body.appendChild(status);

window.addEventListener('error', (e) => beacon('error', `error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) =>
  beacon('error', `reject: ${String(e.reason)}`),
);

run().catch((e) => {
  status.textContent = 'error: ' + String(e);
  beacon('error', `run failed: ${String(e)}`);
});
