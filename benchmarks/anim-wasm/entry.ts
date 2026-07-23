// G2 spike — find the active-driver-count crossover where advancing ALL drivers
// in one WASM call beats the JS `driver.tick()` loop. Measures kernel-only vs the
// real SpringDriver/TweenDriver.tick path across driver counts, spring and tween,
// on the real browser/GPU. Posts JSON to /results (hyprland-browser-bench).
//
// Fairness note: the WASM figure is kernel-only. The resident integration would
// add a per-frame *scatter* (read each driver's output value out of wasm memory
// into its entity property) — a cheap N-element read the JS path pays implicitly
// by writing in place. So the real wasm cost is (kernel + scatter); this spike
// isolates the compute to find where offloading is even in the running.
import { SpringDriver, TweenDriver, type EasingName } from '@vectojs/animation';

const params = new URLSearchParams(location.search);
const NS = (params.get('ns') ?? '100,1000,10000,100000').split(',').map(Number);
const KINDS = (params.get('kinds') ?? 'spring,tween').split(',') as ('spring' | 'tween')[];
const ITERS = Number(params.get('iters') ?? 60); // steps per trial (a full motion)
const TRIALS = Number(params.get('trials') ?? 8);

interface AnimExports {
  memory: WebAssembly.Memory;
  anim_init(springCap: number, tweenCap: number): void;
  spring_step(dt: number, count: number): void;
  tween_step(dt: number, count: number): void;
  p_s_val(): number;
  p_s_target(): number;
  p_s_vel(): number;
  p_s_stiff(): number;
  p_s_damp(): number;
  p_s_mass(): number;
  p_t_from(): number;
  p_t_to(): number;
  p_t_elapsed(): number;
  p_t_dur(): number;
  p_t_delay(): number;
  p_t_ease(): number;
  p_t_val(): number;
}

const EASINGS: EasingName[] = [
  'linear',
  'easeInQuad',
  'easeOutQuad',
  'easeInOutQuad',
  'easeInCubic',
  'easeOutCubic',
  'easeInOutCubic',
  'easeOutBack',
  'easeInOutBack',
];

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

const status = document.createElement('h2');
status.id = 'status';
status.textContent = 'running anim benchmark…';
document.body.appendChild(status);
window.addEventListener('error', (e) => beacon('error', `error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) =>
  beacon('error', `reject: ${String(e.reason)}`),
);

async function run(): Promise<void> {
  const bytes = await (await fetch('./vectojs_core.wasm')).arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports as unknown as AnimExports;
  const maxN = Math.max(...NS);
  ex.anim_init(maxN, maxN); // allocate once at the high-water mark; view AFTER
  const cap = maxN + 8;
  const f64 = (p: number): Float64Array => new Float64Array(ex.memory.buffer, p, cap);
  const sVal = f64(ex.p_s_val()),
    sTarget = f64(ex.p_s_target()),
    sVel = f64(ex.p_s_vel()),
    sStiff = f64(ex.p_s_stiff()),
    sDamp = f64(ex.p_s_damp()),
    sMass = f64(ex.p_s_mass());
  const tFrom = f64(ex.p_t_from()),
    tTo = f64(ex.p_t_to()),
    tElapsed = f64(ex.p_t_elapsed()),
    tDur = f64(ex.p_t_dur()),
    tDelay = f64(ex.p_t_delay()),
    tEase = f64(ex.p_t_ease()),
    tVal = f64(ex.p_t_val());

  const dtMs = 1000 / 60;
  const dtSec = dtMs / 1000;

  // Seed both the wasm arrays and a fresh JS driver array to an active state.
  function seedSpring(n: number): SpringDriver[] {
    const rand = rng(0xc0ffee);
    const js: SpringDriver[] = [];
    for (let i = 0; i < n; i++) {
      const from = (rand() - 0.5) * 200;
      const to = (rand() - 0.5) * 200;
      const stiffness = 80 + rand() * 300;
      const damping = 5 + rand() * 25;
      const mass = 0.5 + rand() * 2;
      sVal[i] = from;
      sTarget[i] = to;
      sVel[i] = 0;
      sStiff[i] = stiffness;
      sDamp[i] = damping;
      sMass[i] = mass;
      js.push(new SpringDriver(from, to, { stiffness, damping, mass }));
    }
    return js;
  }
  function seedTween(n: number): TweenDriver[] {
    const rand = rng(0x1234);
    const js: TweenDriver[] = [];
    for (let i = 0; i < n; i++) {
      const from = (rand() - 0.5) * 100;
      const to = (rand() - 0.5) * 100;
      const duration = 200 + rand() * 800;
      const delay = rand() * 100;
      const easingId = i % EASINGS.length;
      tFrom[i] = from;
      tTo[i] = to;
      tElapsed[i] = 0;
      tDur[i] = duration;
      tDelay[i] = delay;
      tEase[i] = easingId;
      tVal[i] = from;
      js.push(new TweenDriver(from, to, { duration, delay, easing: EASINGS[easingId] }));
    }
    return js;
  }

  const rows: Record<string, unknown>[] = [];
  for (const kind of KINDS) {
    for (const n of NS) {
      // Time JS: min over TRIALS of (re-seed; run ITERS driver.tick steps).
      let jsBest = Infinity;
      for (let t = 0; t < TRIALS; t++) {
        const js = kind === 'spring' ? seedSpring(n) : seedTween(n);
        const t0 = performance.now();
        for (let it = 0; it < ITERS; it++) for (let i = 0; i < n; i++) js[i].tick(dtMs);
        const dt = performance.now() - t0;
        if (dt < jsBest) jsBest = dt;
      }
      // Time WASM: min over TRIALS of (re-seed; run ITERS kernel steps).
      let wasmBest = Infinity;
      for (let t = 0; t < TRIALS; t++) {
        if (kind === 'spring') seedSpring(n);
        else seedTween(n);
        const t0 = performance.now();
        if (kind === 'spring') for (let it = 0; it < ITERS; it++) ex.spring_step(dtSec, n);
        else for (let it = 0; it < ITERS; it++) ex.tween_step(dtMs, n);
        const dt = performance.now() - t0;
        if (dt < wasmBest) wasmBest = dt;
      }
      const jsNs = (jsBest / ITERS / n) * 1e6;
      const wasmNs = (wasmBest / ITERS / n) * 1e6;
      rows.push({
        kind,
        n,
        jsNsPerDriver: Number(jsNs.toFixed(3)),
        wasmNsPerDriver: Number(wasmNs.toFixed(3)),
        speedup: Number((jsNs / wasmNs).toFixed(2)),
      });
      beacon('info', `${kind} n=${n}: js=${jsNs.toFixed(2)} wasm=${wasmNs.toFixed(2)}`);
      status.textContent = `done ${rows.length}/${KINDS.length * NS.length}…`;
    }
  }

  const report = {
    name: 'anim-wasm',
    engine: engineTag(),
    userAgent: navigator.userAgent,
    crossOriginIsolated: self.crossOriginIsolated,
    iters: ITERS,
    trials: TRIALS,
    note: 'wasm figure is kernel-only (excludes per-frame scatter of output values)',
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
