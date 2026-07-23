// G3 spike — is a hit-test broad-phase worth it, and does WASM beat a JS grid?
// Three methods for "topmost entity whose AABB contains a pointer":
//   walk : O(N) brute-force scan (models today's findHitRecursively per event)
//   shg  : the existing @vectojs/math SpatialHashGrid (JS, string ids, Set)
//   wasm : the dense-grid kernel (hit_build once per frame, hit_query per event)
// Reports per-QUERY ns (the pointer-event cost) for all three, and per-BUILD ms
// (the per-frame index cost) for the two grids, so amortization is visible. Real
// browser/GPU; posts JSON to /results (hyprland-browser-bench).
import { SpatialHashGrid } from '@vectojs/math';

const params = new URLSearchParams(location.search);
const NS = (params.get('ns') ?? '1000,10000,100000').split(',').map(Number);
const VW = Number(params.get('vw') ?? 1280);
const VH = Number(params.get('vh') ?? 800);
const CS = Number(params.get('cs') ?? 64);
const QUERIES = Number(params.get('queries') ?? 2000);
const TRIALS = Number(params.get('trials') ?? 8);

interface HitExports {
  memory: WebAssembly.Memory;
  hit_init(entityCap: number, cellCap: number, itemCap: number): void;
  hit_build(count: number, vw: number, vh: number, cellSize: number): void;
  hit_query(px: number, py: number): number;
  hit_overflow(): number;
  p_h_minx(): number;
  p_h_miny(): number;
  p_h_maxx(): number;
  p_h_maxy(): number;
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0x100000000);
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
function minOf(fn: () => number): number {
  let best = Infinity;
  for (let t = 0; t < TRIALS; t++) {
    const v = fn();
    if (v < best) best = v;
  }
  return best;
}

const status = document.createElement('h2');
status.id = 'status';
status.textContent = 'running hit benchmark…';
document.body.appendChild(status);
window.addEventListener('error', (e) => beacon('error', `error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) =>
  beacon('error', `reject: ${String(e.reason)}`),
);

async function run(): Promise<void> {
  const bytes = await (await fetch('./vectojs_core.wasm')).arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports as unknown as HitExports;
  const maxN = Math.max(...NS);
  const gw = Math.ceil(VW / CS);
  const gh = Math.ceil(VH / CS);
  ex.hit_init(maxN, gw * gh, maxN * 16);
  const cap = maxN + 8;
  const f64 = (p: number): Float64Array => new Float64Array(ex.memory.buffer, p, cap);
  const wminx = f64(ex.p_h_minx()),
    wminy = f64(ex.p_h_miny()),
    wmaxx = f64(ex.p_h_maxx()),
    wmaxy = f64(ex.p_h_maxy());

  // Fixed query points (same across methods and N).
  const qx = new Float64Array(QUERIES);
  const qy = new Float64Array(QUERIES);
  {
    const q = rng(0x77);
    for (let i = 0; i < QUERIES; i++) {
      qx[i] = q() * VW;
      qy[i] = q() * VH;
    }
  }

  const rows: Record<string, unknown>[] = [];
  for (const n of NS) {
    // Scene AABBs (small boxes, some spilling outside the viewport).
    const minx = new Float64Array(n),
      miny = new Float64Array(n),
      maxx = new Float64Array(n),
      maxy = new Float64Array(n);
    const rand = rng(0xbeef);
    for (let i = 0; i < n; i++) {
      const w = 8 + rand() * 60;
      const h = 8 + rand() * 60;
      const x = rand() * (VW + 200) - 100;
      const y = rand() * (VH + 200) - 100;
      minx[i] = x;
      miny[i] = y;
      maxx[i] = x + w;
      maxy[i] = y + h;
      wminx[i] = x;
      wminy[i] = y;
      wmaxx[i] = x + w;
      wmaxy[i] = y + h;
    }

    // walk: O(N) topmost scan per query.
    const walkQ = minOf(() => {
      const t0 = performance.now();
      let sink = 0;
      for (let k = 0; k < QUERIES; k++) {
        const px = qx[k],
          py = qy[k];
        let best = -1;
        for (let i = 0; i < n; i++) {
          if (px >= minx[i] && px <= maxx[i] && py >= miny[i] && py <= maxy[i] && i > best)
            best = i;
        }
        sink += best;
      }
      const dt = performance.now() - t0;
      if (sink === -123456789) beacon('info', 'unreachable');
      return dt;
    });

    // shg: existing SpatialHashGrid. Build = clear + insert N; query = topmost of
    // the candidate set (string ids → parse back to index).
    const grid = new SpatialHashGrid(CS);
    const shgBuild = minOf(() => {
      const t0 = performance.now();
      grid.clear();
      for (let i = 0; i < n; i++) {
        grid.insert(String(i), minx[i], miny[i], maxx[i] - minx[i], maxy[i] - miny[i]);
      }
      return performance.now() - t0;
    });
    const shgQ = minOf(() => {
      const t0 = performance.now();
      let sink = 0;
      for (let k = 0; k < QUERIES; k++) {
        const px = qx[k],
          py = qy[k];
        let best = -1;
        for (const id of grid.query(px, py, 0, 0)) {
          const i = +id;
          if (px >= minx[i] && px <= maxx[i] && py >= miny[i] && py <= maxy[i] && i > best)
            best = i;
        }
        sink += best;
      }
      const dt = performance.now() - t0;
      if (sink === -123456789) beacon('info', 'unreachable');
      return dt;
    });

    // wasm: dense-grid kernel.
    const wasmBuild = minOf(() => {
      const t0 = performance.now();
      ex.hit_build(n, VW, VH, CS);
      return performance.now() - t0;
    });
    if (ex.hit_overflow()) beacon('error', `wasm overflow at n=${n}`);
    const wasmQ = minOf(() => {
      const t0 = performance.now();
      let sink = 0;
      for (let k = 0; k < QUERIES; k++) sink += ex.hit_query(qx[k], qy[k]);
      const dt = performance.now() - t0;
      if (sink === -123456789) beacon('info', 'unreachable');
      return dt;
    });

    const perQ = (ms: number): number => Number(((ms / QUERIES) * 1e6).toFixed(1));
    rows.push({
      n,
      walkQueryNs: perQ(walkQ),
      shgQueryNs: perQ(shgQ),
      wasmQueryNs: perQ(wasmQ),
      walkVsWasm: Number((walkQ / wasmQ).toFixed(1)),
      shgBuildMs: Number(shgBuild.toFixed(3)),
      wasmBuildMs: Number(wasmBuild.toFixed(3)),
    });
    beacon(
      'info',
      `n=${n}: walkQ=${perQ(walkQ)} shgQ=${perQ(shgQ)} wasmQ=${perQ(wasmQ)} wasmBuild=${wasmBuild.toFixed(2)}ms`,
    );
    status.textContent = `done ${rows.length}/${NS.length}…`;
  }

  const report = {
    name: 'hit-wasm',
    engine: engineTag(),
    userAgent: navigator.userAgent,
    crossOriginIsolated: self.crossOriginIsolated,
    viewport: { vw: VW, vh: VH, cellSize: CS },
    queries: QUERIES,
    trials: TRIALS,
    note: 'walk/shg/wasm = per-query ns; build = per-frame ms to index all N',
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
