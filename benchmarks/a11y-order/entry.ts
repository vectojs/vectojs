// Per-frame cost of the a11y projection + DOM-order pass as the interactive
// tree grows. After DEC-0020 the order scratch lives on A11yProjectionManager
// (`scene.a11yOrder`); `enforceA11yDomOrder` always runs its own collect walk
// (the old fused-into-syncA11y path was retired with the manager extraction).
//
// Rows report what a synced frame actually pays:
//   syncMs     — syncA11y alone (create/update shadow nodes)
//   enforceMs  — enforceA11yDomOrder alone (collect + prune + reorder)
//   combinedMs — both, in that order (the loop's real sequence)
//
// Posts JSON to /results (hyprland-browser-bench contract).
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

type Mode = 'sync' | 'enforce' | 'combined';

async function bench(scene: Scene, mode: Mode): Promise<number> {
  const s = scene as any;
  // Warm: build all shadow elements once so the timed loop measures the steady
  // update/reorder path, not first-time DOM creation.
  s.syncA11y(s.root);
  s.enforceA11yDomOrder();
  const times: number[] = [];
  for (let t = 0; t < TRIALS; t++) {
    const t0 = performance.now();
    for (let f = 0; f < FRAMES; f++) {
      s.a11yNeedsReorder = true;
      if (mode === 'sync' || mode === 'combined') s.syncA11y(s.root);
      if (mode === 'enforce' || mode === 'combined') s.enforceA11yDomOrder();
    }
    times.push((performance.now() - t0) / FRAMES);
    // Yield so a large tree never trips the browser's "page unresponsive" dialog.
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
    const scene = makeScene(n);
    const syncMs = await bench(scene, 'sync');
    await yieldToPaint();
    const enforceMs = await bench(scene, 'enforce');
    await yieldToPaint();
    const combinedMs = await bench(scene, 'combined');
    rows.push({
      nodes: n,
      syncMsPerFrame: +syncMs.toFixed(4),
      enforceMsPerFrame: +enforceMs.toFixed(4),
      combinedMsPerFrame: +combinedMs.toFixed(4),
    });
    // Drop the canvas so the next count starts clean.
    scene.canvas.remove();
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
