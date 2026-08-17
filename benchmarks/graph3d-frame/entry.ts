// Issue #563: the *integrated* per-frame cost of the Graph3D stack, measured
// inside a real requestAnimationFrame loop. `benchmarks/graph-layout` times
// `layout.step()` in isolation (no renderer, no rAF); this benchmark drives the
// full stack — `VectoForceLayout.step()` → `Graph3D.applyPositions()` →
// `WebGLRenderer.render()` — one tick per frame, and reports each phase's cost
// against the calibrated refresh budget.
//
// It is the prerequisite evidence for the Rust/WASM `VectoForceLayout` kernel
// research gate (vectojs-docs/TODO.md, DEC-0036): that trigger asks for the
// *integrated* JS tick exceeding 2-3 ms or missing the refresh budget, and the
// isolated figures cannot substitute for it because nothing in `packages/graph3d`
// drives a tick inside a rAF loop — the layout is caller-driven.
import { Graph3D, GraphCamera, VectoForceLayout, type GraphData } from '@vectojs/graph3d';
import * as THREE from 'three';
import {
  awaitStart,
  calibrateRefreshRate,
  reportFailure,
  reportResult,
} from '../_shared/client.ts';
import { summarize } from '../_shared/stats.ts';

const params = new URLSearchParams(location.search);
const COUNTS = (params.get('counts') ?? '500,1000,2000,5000,10000').split(',').map(Number);
const TRIALS = Number(params.get('trials') ?? 4);
const FRAMES = Number(params.get('frames') ?? 120);
const WARMUP_FRAMES = Number(params.get('warmupFrames') ?? 30);
const WORKLOAD = params.get('workload') ?? 'mixed-sparse';

/** Deterministic 32-bit PRNG (mulberry32), so the generated graph is fixed. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGraph(count: number, workload: string): GraphData {
  const nodes = Array.from({ length: count }, (_, id) => ({
    id,
    x: Math.cos(id * 2.399) * Math.sqrt(id + 1) * 10,
    y: Math.sin(id * 2.399) * Math.sqrt(id + 1) * 10,
    z: Math.cos(id * 1.618) * Math.sqrt(id + 1) * 10,
    val: 1 + (id % 5),
  }));
  const links: GraphData['links'] = [];
  if (workload === 'star-hub') {
    for (let id = 1; id < count; id++) links.push({ source: 0, target: id });
    return { nodes, links };
  }
  const random = rng(0x6c1a);
  for (let id = 1; id < count; id++) links.push({ source: id, target: Math.floor(random() * id) });
  for (let edge = 0; edge < Math.floor(count * 0.5); edge++) {
    const source = Math.floor(random() * count);
    const target = Math.floor(random() * count);
    if (source !== target) links.push({ source, target });
  }
  return { nodes, links };
}

interface FrameSample {
  step: number[];
  apply: number[];
  render: number[];
  total: number[];
  activeFrames: number;
}

/**
 * Drive one measured window inside rAF: reheat, then step + applyPositions +
 * render once per frame for `frames` callbacks, timing each phase. `step` is
 * collected only for frames where the simulation was still active (a cooled
 * `step()` is a no-op, not a tick). The full-window alpha decay is ~0.9772^frames,
 * so with the default 120 frames every frame stays active (~0.06 alpha at the end).
 */
function measureWindow(
  layout: VectoForceLayout,
  graph: Graph3D,
  renderer: THREE.WebGLRenderer,
  camera: GraphCamera,
  scene: THREE.Scene,
  frames: number,
): Promise<FrameSample> {
  return new Promise((resolve) => {
    const step: number[] = [];
    const apply: number[] = [];
    const render: number[] = [];
    const total: number[] = [];
    let activeFrames = 0;
    let frame = 0;
    layout.reheat(1);
    const loop = (): void => {
      const t0 = performance.now();
      const active = layout.step();
      const t1 = performance.now();
      graph.applyPositions(layout.positions);
      const t2 = performance.now();
      renderer.render(scene, camera.camera);
      const t3 = performance.now();
      if (active) {
        activeFrames += 1;
        step.push(t1 - t0);
      }
      apply.push(t2 - t1);
      render.push(t3 - t2);
      total.push(t3 - t0);
      frame += 1;
      if (frame >= frames) {
        resolve({ step, apply, render, total, activeFrames });
        return;
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
}

async function main(): Promise<void> {
  await awaitStart();
  const refreshHz = await calibrateRefreshRate(1000);
  const budgetMs = 1000 / refreshHz;
  const startedAt = performance.now();
  const progress = document.createElement('pre');
  document.body.appendChild(progress);

  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const key = new THREE.DirectionalLight(0xffffff, 0.8);
  key.position.set(200, 300, 400);
  scene.add(key);

  const rows: Array<Record<string, string | number>> = [];

  for (const count of COUNTS) {
    const data = makeGraph(count, WORKLOAD);
    const layout = new VectoForceLayout();
    layout.setGraph(data);
    const graph = new Graph3D({ nodeRadius: 4 });
    graph.setGraphData(data);
    graph.applyPositions(layout.positions);
    scene.add(graph.group);

    // 2D ortho view, like a flat knowledge-graph. Framed generously so the graph
    // stays visible as it expands during the measured windows (nodeMesh keeps
    // frustum culling on; an off-screen graph would be culled and look cheap).
    const camera = new GraphCamera({
      domElement: renderer.domElement,
      mode: '2d',
      orthoHalfHeight: 250,
    });
    camera.fitToPositions(layout.positions, 1.6);

    progress.textContent = `${WORKLOAD}: ${count} nodes`;
    // Unmeasured warm-up: compile shaders, JIT the hot path, expand the graph a
    // little past its seeded placement so the camera framing stays representative.
    for (let f = 0; f < WARMUP_FRAMES; f++) {
      layout.step();
      graph.applyPositions(layout.positions);
      renderer.render(scene, camera.camera);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }

    const step: number[] = [];
    const apply: number[] = [];
    const render: number[] = [];
    const total: number[] = [];
    let activeFrames = 0;
    for (let trial = 0; trial < TRIALS; trial++) {
      const sample = await measureWindow(layout, graph, renderer, camera, scene, FRAMES);
      step.push(...sample.step);
      apply.push(...sample.apply);
      render.push(...sample.render);
      total.push(...sample.total);
      activeFrames += sample.activeFrames;
    }

    const stepStats = summarize(step);
    const applyStats = summarize(apply);
    const renderStats = summarize(render);
    const totalStats = summarize(total);
    rows.push({
      workload: WORKLOAD,
      nodes: count,
      links: data.links.length,
      trials: TRIALS,
      framesPerTrial: FRAMES,
      activeSamples: activeFrames,
      stepMedianMs: +stepStats.median.toFixed(4),
      stepP95Ms: +stepStats.p95.toFixed(4),
      stepMaxMs: +stepStats.max.toFixed(4),
      applyMedianMs: +applyStats.median.toFixed(4),
      applyP95Ms: +applyStats.p95.toFixed(4),
      renderMedianMs: +renderStats.median.toFixed(4),
      renderP95Ms: +renderStats.p95.toFixed(4),
      totalMedianMs: +totalStats.median.toFixed(4),
      totalP95Ms: +totalStats.p95.toFixed(4),
      totalMaxMs: +totalStats.max.toFixed(4),
      budgetMs: +budgetMs.toFixed(4),
      stepShareOfBudgetPct: +((stepStats.median / budgetMs) * 100).toFixed(1),
      totalShareOfBudgetPct: +((totalStats.median / budgetMs) * 100).toFixed(1),
    });

    graph.dispose();
    camera.dispose();
    layout.dispose();
    scene.remove(graph.group);
  }

  renderer.dispose();

  await reportResult({
    name: 'graph3d-frame',
    params: {
      COUNTS,
      TRIALS,
      FRAMES,
      WARMUP_FRAMES,
      WORKLOAD,
      budgetMs: +budgetMs.toFixed(4),
      refreshHz: +refreshHz.toFixed(2),
      measurement:
        'One VectoForceLayout.step() + Graph3D.applyPositions() + WebGLRenderer.render() per rAF callback, timed with performance.now(). step is collected only for active (non-cooled) frames; apply/render/total over every measured frame.',
      trialState:
        'Each trial reheats alpha to 1 and steps FRAMES times (default 120 < ~300 cool-down ticks, so every frame is active). Trials run sequentially on one layout per count, after an unmeasured warm-up.',
      camera:
        'GraphCamera 2d ortho, fitToPositions padding 1.6 after the seeded placement; nodeMesh keeps frustum culling on, links are never culled (Graph3D default).',
    },
    summary: rows.map((row) => ({
      nodes: row.nodes,
      stepMedianMs: row.stepMedianMs,
      totalMedianMs: row.totalMedianMs,
      budgetMs: row.budgetMs,
      totalShareOfBudgetPct: row.totalShareOfBudgetPct,
    })),
    rows,
    durationMs: +(performance.now() - startedAt).toFixed(1),
  });
  progress.textContent = 'done';
  const output = document.createElement('pre');
  output.textContent = JSON.stringify(rows, null, 2);
  document.body.appendChild(output);
}

main().catch((error) => reportFailure('graph3d-frame', error));
