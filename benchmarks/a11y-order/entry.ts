// P2-F a11y-order bench: per-frame cost of the a11y DOM-order pass as the
// interactive tree grows. Before the fusion, enforceA11yDomOrder re-walked the
// WHOLE tree every synced frame right after syncA11y already walked it (two full
// traversals). Now syncA11y populates the order accumulators during its own walk
// and enforceA11yDomOrder only prunes + reorders from them (one traversal).
//
// A/B: FUSED = syncA11y (collects) + enforceA11yDomOrder (no re-walk). OLD =
// syncA11y + force `_a11yOrderCollected = false` so enforceA11yDomOrder does its
// fallback full-tree collect (the pre-fusion second walk). Posts JSON to
// /results (hyprland-browser-bench contract).
import { Scene, Entity } from '@vectojs/core';
import { awaitStart, reportFailure, reportResult } from '../_shared/client.ts';
import { median } from '../_shared/stats.ts';

const p = new URLSearchParams(location.search);
const COUNTS = (p.get('counts') ?? '500,2000,5000,10000').split(',').map(Number);
const FRAMES = Number(p.get('frames') ?? 40);
const TRIALS = Number(p.get('trials') ?? 5);

// A minimal interactive entity so syncA11y creates a shadow element per node.
class Node extends Entity {
  constructor(id: string) {
    super(id);
    this.interactive = true;
    this.width = 24;
    this.height = 16;
  }
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

function makeScene(count: number): Scene {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  const scene = new Scene(canvas);
  (scene as unknown as { isRunning: boolean }).isRunning = true;
  // A shallow-but-wide tree: a handful of containers each with many children —
  // representative of a real UI (toolbars, lists, grids) and exercises the walk.
  let made = 1;
  const root = new Node('n0');
  scene.add(root);
  let bucket = new Node(`b${made}`);
  root.add(bucket);
  made++;
  for (; made < count; made++) {
    if (made % 100 === 0) {
      bucket = new Node(`b${made}`);
      root.add(bucket);
    }
    bucket.add(new Node(`n${made}`));
  }
  return scene;
}

const yieldToPaint = () => new Promise((r) => setTimeout(r, 0));

async function bench(scene: Scene, forceSecondWalk: boolean): Promise<number> {
  const s = scene as any;
  s.syncA11y(s.root); // warm: build all shadow elements once
  s.enforceA11yDomOrder();
  const times: number[] = [];
  for (let t = 0; t < TRIALS; t++) {
    const t0 = performance.now();
    for (let f = 0; f < FRAMES; f++) {
      s.fullViewportElements.length = 0;
      s.normalElements.length = 0;
      s.activeIds.clear();
      s._a11yOrderCollected = true;
      s.syncA11y(s.root);
      if (forceSecondWalk) s._a11yOrderCollected = false; // pre-fusion: re-walk
      s.a11yNeedsReorder = true; // force the reorder body to run each frame
      s.enforceA11yDomOrder();
    }
    times.push((performance.now() - t0) / FRAMES);
    // Yield to the event loop between trials so a large tree never blocks the
    // main thread long enough to trip the browser's "page unresponsive" dialog
    // (which would both stall the run and skew timings).
    await yieldToPaint();
  }
  return median(times);
}

async function main() {
  await awaitStart();
  const startedAt = performance.now();
  const progress = document.createElement('pre');
  document.body.appendChild(progress);
  const rows: any[] = [];
  for (const n of COUNTS) {
    progress.textContent = `benchmarking ${n} nodes…`;
    await yieldToPaint();
    const oldMs = await bench(makeScene(n), true);
    await yieldToPaint();
    const fusedMs = await bench(makeScene(n), false);
    rows.push({
      nodes: n,
      oldTwoWalkMsPerFrame: +oldMs.toFixed(4),
      fusedMsPerFrame: +fusedMs.toFixed(4),
      speedup: +(oldMs / fusedMs).toFixed(2),
    });
  }
  const result = await reportResult({
    name: 'a11y-order',
    params: { COUNTS, FRAMES, TRIALS },
    rows,
    durationMs: +(performance.now() - startedAt).toFixed(1),
  });
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(result, null, 2);
  document.body.appendChild(pre);
}

main().catch((error) => reportFailure('a11y-order', error));
