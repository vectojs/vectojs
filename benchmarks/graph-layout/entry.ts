// P2-I graph-layout bench: per-tick cost of the in-house VectoForceLayout
// (Barnes-Hut O(N log N) + springs + centering, dependency-free) vs the
// third-party D3ForceLayout (d3-force-3d) it's an alternative to, over a
// scale-free-ish graph swept by node count. Posts JSON to /results
// (hyprland-browser-bench contract). Both run the SAME graph; we report ms per
// tick (median), so it's a like-for-like per-frame layout cost comparison.
import { VectoForceLayout, D3ForceLayout, type GraphData } from '@vectojs/graph3d';
import { awaitStart, reportFailure, reportResult } from '../_shared/client.ts';
import { median } from '../_shared/stats.ts';

const p = new URLSearchParams(location.search);
const COUNTS = (p.get('counts') ?? '500,1000,2000,5000').split(',').map(Number);
const TICKS = Number(p.get('ticks') ?? 30);
const TRIALS = Number(p.get('trials') ?? 6);

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0x100000000);
}

// A connected graph: a spanning path + extra random edges (~1.5 edges/node),
// the kind of density a real force graph faces.
function makeGraph(n: number): GraphData {
  const rand = rng(0x6c1a);
  const nodes = Array.from({ length: n }, (_, i) => ({ id: i }));
  const links: GraphData['links'] = [];
  for (let i = 1; i < n; i++) links.push({ source: i, target: Math.floor(rand() * i) });
  const extra = Math.floor(n * 0.5);
  for (let e = 0; e < extra; e++) {
    const a = Math.floor(rand() * n);
    const b = Math.floor(rand() * n);
    if (a !== b) links.push({ source: a, target: b });
  }
  return { nodes, links };
}

const yieldToPaint = () => new Promise((r) => setTimeout(r, 0));

async function benchTickMs(
  make: () => VectoForceLayout | D3ForceLayout,
  graph: GraphData,
): Promise<number> {
  const times: number[] = [];
  for (let t = 0; t < TRIALS; t++) {
    const layout = make();
    layout.setGraph(graph);
    layout.reheat?.(1); // keep it hot so every tick does real work
    const t0 = performance.now();
    layout.step(TICKS);
    times.push((performance.now() - t0) / TICKS);
    layout.dispose();
    await yieldToPaint(); // stay responsive between trials
  }
  return median(times);
}

async function main() {
  await awaitStart();
  const startedAt = performance.now();
  const progress = document.createElement('pre');
  document.body.appendChild(progress);
  const rows: Array<Record<string, number>> = [];
  for (const n of COUNTS) {
    progress.textContent = `benchmarking ${n} nodes…`;
    await yieldToPaint();
    const graph = makeGraph(n);
    const d3Ms = await benchTickMs(() => new D3ForceLayout(), graph);
    await yieldToPaint();
    const vectoMs = await benchTickMs(() => new VectoForceLayout(), graph);
    rows.push({
      nodes: n,
      links: graph.links.length,
      d3ForceMsPerTick: +d3Ms.toFixed(4),
      vectoBarnesHutMsPerTick: +vectoMs.toFixed(4),
      speedup: +(d3Ms / vectoMs).toFixed(2),
    });
  }
  const result = await reportResult({
    name: 'graph-layout',
    params: { COUNTS, TICKS, TRIALS },
    rows,
    durationMs: +(performance.now() - startedAt).toFixed(1),
  });
  progress.textContent = 'done';
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(result, null, 2);
  document.body.appendChild(pre);
}

main().catch((error) => reportFailure('graph-layout', error));
