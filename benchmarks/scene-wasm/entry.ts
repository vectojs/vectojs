// Scene-level browser benchmark for the G1 integration: on REAL Scene/Entity
// trees, compare the JS render-walk transform compose against the resident WASM
// transform path (Scene._syncWasmStore = gather + kernel), per frame. This is the
// integrated-engine confirmation of the Node/V8 signal (bushy ~4.3x, flat ~wash).
// Confirms the number on real Chrome (V8) and Firefox (SpiderMonkey). Posts JSON
// to /results (hyprland-browser-bench contract).
import { Scene, Entity } from '@vectojs/core';

const p = new URLSearchParams(location.search);
const NS = (p.get('ns') ?? '10000,100000').split(',').map(Number);
const TOPOS = (p.get('topos') ?? 'flat,bushy').split(',') as ('flat' | 'bushy')[];
const ITERS = Number(p.get('iters') ?? 50);
const TRIALS = Number(p.get('trials') ?? 12);

class Box extends Entity {
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

function sceneWith(): Scene {
  const canvas = document.createElement('canvas');
  canvas.width = 400;
  canvas.height = 300;
  const scene = new Scene(canvas);
  (scene as unknown as { isRunning: boolean }).isRunning = true;
  return scene;
}

function buildTree(scene: Scene, n: number, topo: 'flat' | 'bushy'): void {
  let rng = 12345;
  const rand = () => ((rng = (rng * 1664525 + 1013904223) >>> 0), rng / 0x100000000);
  const nodes: Box[] = [];
  for (let i = 0; i < n; i++) {
    const e = new Box();
    e.x = (rand() - 0.5) * 100;
    e.y = (rand() - 0.5) * 100;
    e.rotation = (rand() - 0.5) * 2;
    e.scaleX = 0.5 + rand();
    nodes.push(e);
    if (i === 0) scene.add(e);
    else if (topo === 'flat') nodes[0].add(e);
    else nodes[Math.floor(rand() * i)].add(e); // bushy: shallow random tree
  }
}

// Exactly what Scene.renderNode composes per node (minus drawing): the js-mode
// transform cost. Public Entity API: _getTrig()/_setWorldCache() (Phase 0).
function jsWalk(
  node: Entity,
  pa: number,
  pb: number,
  pc: number,
  pd: number,
  pe: number,
  pf: number,
  frame: number,
): void {
  const trig = node._getTrig();
  const cos = trig.cos;
  const sin = trig.sin;
  const te = pa * node.x + pc * node.y + pe;
  const tf = pb * node.x + pd * node.y + pf;
  const sxCos = node.scaleX * cos;
  const sxSin = node.scaleX * sin;
  const syCos = node.scaleY * cos;
  const sySin = node.scaleY * sin;
  const a = pa * sxCos + pc * sySin;
  const b = pb * sxCos + pd * sySin;
  const c = pa * -sxSin + pc * syCos;
  const d = pb * -sxSin + pd * syCos;
  node._setWorldCache(a, b, c, d, te, tf, frame);
  const kids = node.children;
  for (let i = 0; i < kids.length; i++) jsWalk(kids[i], a, b, c, d, te, tf, frame);
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
status.textContent = 'running scene benchmark…';
document.body.appendChild(status);
window.addEventListener('error', (e) => beacon('error', `error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) =>
  beacon('error', `reject: ${String(e.reason)}`),
);

async function run(): Promise<void> {
  const bytes = await (await fetch('./vectojs_core.wasm')).arrayBuffer();
  const rows: Record<string, unknown>[] = [];
  let frame = 1000;

  for (const topo of TOPOS) {
    for (const n of NS) {
      const scene = sceneWith();
      buildTree(scene, n, topo);
      const wasmOk = await scene.enableWasmTransforms(bytes);
      const sync = () => (scene as unknown as { _syncWasmStore: () => void })._syncWasmStore();
      const root = (scene as unknown as { root: Entity }).root;
      sync(); // prime the structural rebuild

      // Warm up both paths.
      for (let i = 0; i < 10; i++) {
        jsWalk(root, 1, 0, 0, 1, 0, 0, frame++);
        sync();
      }
      const jsMs = minMs(() => {
        for (let i = 0; i < ITERS; i++) jsWalk(root, 1, 0, 0, 1, 0, 0, frame++);
      });
      const wasmMs = minMs(() => {
        for (let i = 0; i < ITERS; i++) sync();
      });
      const jsNs = (jsMs / ITERS / n) * 1e6;
      const wasmNs = (wasmMs / ITERS / n) * 1e6;
      rows.push({
        topo,
        n,
        wasmAvailable: wasmOk,
        jsNsPerEntity: Number(jsNs.toFixed(2)),
        wasmNsPerEntity: Number(wasmNs.toFixed(2)),
        speedup: Number((jsNs / wasmNs).toFixed(2)),
      });
      beacon('info', `${topo} n=${n}: js=${jsNs.toFixed(1)} wasm=${wasmNs.toFixed(1)}`);
      status.textContent = `done ${rows.length}/${TOPOS.length * NS.length}…`;
    }
  }

  const report = {
    name: 'scene-wasm',
    engine: engineTag(),
    userAgent: navigator.userAgent,
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
  status.textContent = `done: ${rows.length} cells posted — you can close this window`;
}

run().catch((e) => {
  status.textContent = 'error: ' + String(e);
  beacon('error', `run failed: ${String(e)}`);
});
