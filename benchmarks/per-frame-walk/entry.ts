// CTX-0057 — per-frame full-tree walk cost as content grows.
//
// Scene.render() runs, every synced frame, several O(tree) walks. This bench
// isolates two of them on a scene with ZERO compute entities (the overwhelmingly
// common case — a normal UI / document has no ComputeParticleEntity):
//
//   1. collectComputeEntities: BEFORE this task it walked the whole tree every
//      frame just to build an empty array; now it's cached per structure
//      version, so a structurally-stable frame is O(1). We measure both by
//      toggling the cache off (re-walk each call) vs on.
//   2. syncA11y: the a11y/content-projection sync walk. Reported as a reference
//      so we can see whether the compute-walk removal is meaningful relative to
//      the walk that remains (evidence-first, per the CTX-0048 precedent).
//
// A plain decorative Entity subtree (no interactive nodes, no content
// projection) models a big static scene; nodes are stacked vertically so most
// sit outside the viewport (the realistic long-document shape). Posts JSON to
// /results (browser-bench contract).
import { Scene, Entity } from '@vectojs/core';

const p = new URLSearchParams(location.search);
const NODE_COUNTS = (p.get('nodes') ?? '500,1000,2000,4000,8000,16000').split(',').map(Number);
const TRIALS = Number(p.get('trials') ?? 30);
const VIEW_W = 900;
const VIEW_H = 700;

// A purely decorative node: not interactive, no content projection. This is the
// bulk of a real scene graph (panels, rows, separators, icons drawn on canvas).
class DecoNode extends Entity {
  constructor(id: string) {
    super(id);
    this.width = 40;
    this.height = 18;
  }
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

function makeScene(): Scene {
  const canvas = document.createElement('canvas');
  canvas.width = VIEW_W;
  canvas.height = VIEW_H;
  document.body.appendChild(canvas);
  const scene = new Scene(canvas);
  (scene as unknown as { isRunning: boolean }).isRunning = true;
  scene.maxFPS = 0;
  return scene;
}

// Build a wide-and-shallow tree (rows of small nodes), stacked down the page so
// most are off-viewport — the long-document / big-dashboard shape.
function buildTree(scene: Scene, n: number): void {
  const perRow = 10;
  let row: Entity | null = null;
  for (let i = 0; i < n; i++) {
    if (i % perRow === 0) {
      row = new DecoNode(`row${i}`);
      row.setPosition(10, 6 + (i / perRow) * 22);
      scene.add(row);
    }
    const leaf = new DecoNode(`n${i}`);
    leaf.setPosition((i % perRow) * 44, 0);
    row!.add(leaf);
  }
}

function median(xs: number[]): number {
  xs.sort((a, b) => a - b);
  return xs[Math.floor(xs.length / 2)]!;
}

// Cost of ONE collectComputeEntities pass. We time both the cached call
// (structurally stable → O(1)) and a forced re-walk (the pre-cache behavior) by
// bumping the structure version between calls.
function measureComputeWalk(scene: Scene): {
  cached: number;
  uncached: number;
} {
  const s = scene as any;
  // Warm the cache.
  s._computeEntitiesFor(s._structureVersion);

  const cachedTimes: number[] = [];
  for (let t = 0; t < TRIALS; t++) {
    const t0 = performance.now();
    s._computeEntitiesFor(s._structureVersion); // same version → cache hit
    cachedTimes.push(performance.now() - t0);
  }

  const uncachedTimes: number[] = [];
  let fakeVersion = 1_000_000;
  for (let t = 0; t < TRIALS; t++) {
    const t0 = performance.now();
    s._computeEntitiesFor(fakeVersion++); // new version each call → full re-walk
    uncachedTimes.push(performance.now() - t0);
  }
  return { cached: median(cachedTimes), uncached: median(uncachedTimes) };
}

// Reference: cost of ONE syncA11y walk over the same tree — the a11y/content
// sync path that remains O(tree) every synced frame. Reported so the
// compute-walk removal can be weighed against the walk that stays. NOTE this is
// a REFERENCE, not a claimed optimization: syncA11y can't safely skip subtrees
// (a node's content projection is a dynamic method with no invalidation hook),
// and in the real loop render() runs first and stamps each entity's
// world-matrix cache, so getWorldTransform() here is already the O(1) fast
// path. No change is made to this walk (evidence-first, per CTX-0048).
function measureSyncA11y(scene: Scene): number {
  const s = scene as any;
  s.syncA11y(s.root); // warm caches/materialization
  const times: number[] = [];
  for (let t = 0; t < TRIALS; t++) {
    scene.markDirty();
    const t0 = performance.now();
    s.syncA11y(s.root);
    times.push(performance.now() - t0);
  }
  return median(times);
}

async function main() {
  const engine = /firefox/i.test(navigator.userAgent) ? 'firefox' : 'chrome';
  const rows: any[] = [];
  for (const n of NODE_COUNTS) {
    const scene = makeScene();
    buildTree(scene, n);
    const compute = measureComputeWalk(scene);
    const syncA11y = measureSyncA11y(scene);
    scene.destroy();
    rows.push({
      nodes: n,
      computeWalkCachedMs: +compute.cached.toFixed(5),
      computeWalkUncachedMs: +compute.uncached.toFixed(5),
      computeWalkSpeedup: +(compute.uncached / Math.max(compute.cached, 1e-6)).toFixed(1),
      syncA11yWalkRefMs: +syncA11y.toFixed(4),
    });
  }
  const payload = {
    name: 'per-frame-walk',
    engine,
    userAgent: navigator.userAgent,
    params: { NODE_COUNTS, TRIALS, VIEW_W, VIEW_H },
    rows,
  };
  try {
    await fetch('/results', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // ignore — the page still shows the table below
  }
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(payload, null, 2);
  document.body.appendChild(pre);
}

main();
