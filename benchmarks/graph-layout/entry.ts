// Issue #540: real-browser per-tick and incremental-topology costs for the two
// existing Graph3D layouts and the standalone 2D graph-layout package.
//
// Default-matrix budget (CTX-0517, measured 2026-08-26): the original defaults
// (counts 100,500,1000,3000 × 2 workloads × 4 arms × TRIALS 6, SETTLE_CAP 500)
// exceeded any sane in-harness budget — >1500 s/engine projected from single-cell
// measurements, settle-dominated (each settle tick pays a ~4 ms timer-clamped
// event-loop yield, and settles ran to natural convergence at ~285-300 ticks,
// i.e. essentially every trial paid near-full CAP ticks). Two budget levers,
// chosen so the full default completes in well under ~300 s per engine WITHOUT
// dropping any scenario (all 2 workloads × 4 layout arms remain, per size):
//   - SETTLE_CAP 500 → 120: settle statistics measure the FIRST 120 post-append
//     ticks (the deterministic initial transient), not convergence-to-alpha-floor;
//     natural convergence was measured at ~285-300 ticks at alphaDecay 0.024, so
//     capped trials are expected and settleCappedTrials == TRIALS by design. The
//     2026-08-25 sweep (CTX-0509) already quoted cap-120 settle data, so this is
//     continuous with the most recent published figures.
//   - counts 100,500,1000,3000 → 100,1000,3000: dropped 500, the nearest
//     log-scale neighbour of 1000 (both mid-size); small/mid/large coverage and
//     the #559 baseline size (3000) are retained.
//   - TRIALS 6 → 3: the in-page trial count of the #559 baseline protocol and of
//     every previously published graph-layout figure (three trials, suite-level
//     repetition handled by run-browsers.sh --iterations). Halves the dominant
//     per-tick yield overhead (~4 ms timer-clamped event-loop yield per step).
// Measured full-default cost after budgeting: ~150 s headless Chrome
// (preflight-mt9vw80t envelope), against >1500 s projected for the old defaults.
import { ForceLayout2D } from '@vectojs/graph-layout';
import { D3ForceLayout, VectoForceLayout, type GraphData } from '@vectojs/graph3d';
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type ForceLink,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import { awaitStart, reportFailure, reportResult } from '../_shared/client.ts';
import { median, percentile } from '../_shared/stats.ts';

const params = new URLSearchParams(location.search);
// Budgeted defaults — see the header comment. Overridable per-run for deeper
// sweeps, e.g. `?counts=100,500,1000,3000&settleCap=500` reproduces the old
// full-convergence matrix within an explicit budget.
const COUNTS = (params.get('counts') ?? '100,1000,3000').split(',').map(Number);
const TICKS = Number(params.get('ticks') ?? 30);
const TRIALS = Number(params.get('trials') ?? 3);
const SETTLE_CAP = Number(params.get('settleCap') ?? 120);
const parsedUaMemoryTimeoutMs = Number(params.get('uaMemoryTimeoutMs') ?? 1250);
const UA_MEMORY_TIMEOUT_MS =
  Number.isFinite(parsedUaMemoryTimeoutMs) && parsedUaMemoryTimeoutMs > 0
    ? parsedUaMemoryTimeoutMs
    : 1250;
const APPEND_NODES = 50;
const WARMUP_TICKS = 5;
const POST_TOPOLOGY_ALPHA = 1;

type Workload = 'star-hub' | 'mixed-sparse';

interface Layout {
  setGraph(graph: GraphData): void;
  step(iterations?: number): boolean;
  reheat(alpha?: number): void;
  dispose(): void;
}

interface ForceNode extends SimulationNodeDatum {
  id: number;
  radius: number;
  charge: number;
}

interface ForceLinkDatum extends SimulationLinkDatum<ForceNode> {}

class D3Force2DLayout implements Layout {
  private simulation: Simulation<ForceNode, undefined> | null = null;
  private linkForce: ForceLink<ForceNode, ForceLinkDatum> | null = null;
  private nodes: ForceNode[] = [];
  private links: ForceLinkDatum[] = [];

  public setGraph(graph: GraphData): void {
    this.nodes = graph.nodes.map((node) => ({
      id: Number(node.id),
      radius: Number(node.radius ?? 10),
      charge: Number(node.charge ?? 300),
      x: node.x,
      y: node.y,
      vx: 0,
      vy: 0,
    }));
    this.links = graph.links.map((link) => ({
      source: Number(link.source),
      target: Number(link.target),
    }));
    this.linkForce = forceLink<ForceNode, ForceLinkDatum>(this.links)
      .id((node) => node.id)
      .distance(
        (link) => 40 + (Number(link.source.radius ?? 10) + Number(link.target.radius ?? 10)) * 1.5,
      )
      .strength(0.42);
    const simulation = forceSimulation<ForceNode>(this.nodes)
      .alpha(1)
      .alphaDecay(0.024)
      .velocityDecay(0.36)
      .force(
        'charge',
        forceManyBody<ForceNode>()
          .strength((node) => -Number(node.charge ?? 300))
          .distanceMax(450)
          .theta(0.9),
      )
      .force('link', this.linkForce)
      .force(
        'collision',
        forceCollide<ForceNode>()
          .radius((node) => node.radius + 14)
          .strength(0.7),
      )
      .force('x', forceX<ForceNode>(0).strength(0.016))
      .force('y', forceY<ForceNode>(0).strength(0.016))
      .stop();
    this.simulation = simulation;
  }

  public appendGraph(graph: GraphData): void {
    if (!this.simulation || !this.linkForce)
      throw new Error('setGraph must run before appendGraph');
    for (const node of graph.nodes) {
      this.nodes.push({
        id: Number(node.id),
        radius: Number(node.radius ?? 10),
        charge: Number(node.charge ?? 300),
        x: node.x,
        y: node.y,
        vx: 0,
        vy: 0,
      });
    }
    for (const link of graph.links) {
      this.links.push({ source: Number(link.source), target: Number(link.target) });
    }
    // The link force retains the same array object, so nodes() reinitializes it
    // once against the appended links while preserving existing node dynamics.
    this.simulation.nodes(this.nodes);
  }

  public step(iterations = 1): boolean {
    if (!this.simulation) return false;
    this.simulation.tick(iterations);
    return this.simulation.alpha() >= 0.001;
  }

  public reheat(alpha = 0.3): void {
    this.simulation?.alpha(Math.max(this.simulation.alpha(), alpha));
  }

  public dispose(): void {
    this.simulation?.stop();
    this.simulation = null;
    this.linkForce = null;
    this.nodes = [];
    this.links = [];
  }
}

interface AppendPayloads {
  added: GraphData;
  complete: GraphData;
}

interface LayoutArm {
  name: 'd3-force-3d' | 'vecto-force' | 'd3-force-2d' | 'force-layout-2d';
  dimensions: 2 | 3;
  appendMode: 'setGraph-rebuild' | 'appendGraph';
  make(): Layout;
  append(layout: Layout, payloads: AppendPayloads): void;
}

interface Samples {
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  samples: number;
}

interface AppendStats {
  append: Samples;
  firstTick: Samples;
  settleTotal: Samples;
  settleTicksMedian: number;
  settleTicksP95: number;
  settleCappedTrials: number;
  maxStepMs: number;
}

interface MemoryObservation {
  status: 'supported' | 'unsupported';
  source: string;
  deltaBytes: number | 'unsupported';
  caveat: string;
  fallbackReason: string;
}

interface MemoryApi {
  measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
  memory?: { usedJSHeapSize?: number };
}

interface LongTaskCapture {
  supported: boolean;
  include(started: number, ended: number): void;
  maxDurationMs(): number | 'unsupported';
  stop(): Promise<void>;
}

let uaMemoryDisabledReason: string | null = null;

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => ((state = (state * 1664525 + 1013904223) >>> 0), state / 0x100000000);
}

function makeGraph(workload: Workload, count: number): GraphData {
  const nodes = Array.from({ length: count }, (_, id) => ({
    id,
    x: Math.cos(id * 2.399) * Math.sqrt(id + 1) * 10,
    y: Math.sin(id * 2.399) * Math.sqrt(id + 1) * 10,
    radius: 8 + (id % 5),
    charge: (8 + (id % 5)) * 11 + 95,
  }));
  const links: GraphData['links'] = [];
  if (workload === 'star-hub') {
    for (let id = 1; id < count; id++) links.push({ source: 0, target: id });
    return { nodes, links };
  }

  const random = rng(0x6c1a);
  for (let id = 1; id < count; id++) {
    links.push({ source: id, target: Math.floor(random() * id) });
  }
  for (let edge = 0; edge < Math.floor(count * 0.5); edge++) {
    const source = Math.floor(random() * count);
    const target = Math.floor(random() * count);
    if (source !== target) links.push({ source, target });
  }
  return { nodes, links };
}

function makeAppend(workload: Workload, count: number): GraphData {
  const nodes = Array.from({ length: APPEND_NODES }, (_, offset) => ({
    id: count + offset,
    x: Math.cos((count + offset) * 2.399) * Math.sqrt(count + offset + 1) * 10,
    y: Math.sin((count + offset) * 2.399) * Math.sqrt(count + offset + 1) * 10,
    radius: 8 + ((count + offset) % 5),
    charge: (8 + ((count + offset) % 5)) * 11 + 95,
  }));
  const links: GraphData['links'] = [];
  if (workload === 'star-hub') {
    for (const node of nodes) links.push({ source: 0, target: node.id });
    return { nodes, links };
  }

  const random = rng(0xa77e0000 ^ count);
  for (const node of nodes) {
    links.push({ source: node.id, target: Math.floor(random() * node.id) });
  }
  for (let edge = 0; edge < Math.floor(APPEND_NODES * 0.5); edge++) {
    const source = nodes[Math.floor(random() * nodes.length)]!.id;
    const target = Math.floor(random() * (count + APPEND_NODES));
    if (source !== target) links.push({ source, target });
  }
  return { nodes, links };
}

function cloneGraph(graph: GraphData): GraphData {
  return {
    nodes: graph.nodes.map((node) => ({ ...node })),
    links: graph.links.map((link) => ({ source: link.source, target: link.target })),
  };
}

function combineGraphs(base: GraphData, added: GraphData): GraphData {
  return {
    nodes: [...base.nodes, ...added.nodes],
    links: [...base.links, ...added.links],
  };
}

function summarize(times: readonly number[]): Samples {
  return {
    samples: times.length,
    medianMs: median(times),
    p95Ms: percentile(times, 0.95),
    maxMs: Math.max(...times),
  };
}

const yieldToPaint = () => new Promise((resolve) => setTimeout(resolve, 0));

function captureLongTasks(): LongTaskCapture {
  const supported =
    typeof PerformanceObserver !== 'undefined' &&
    (PerformanceObserver.supportedEntryTypes?.includes('longtask') ?? false);
  if (!supported) {
    return {
      supported: false,
      include: () => {},
      maxDurationMs: () => 'unsupported',
      stop: async () => {},
    };
  }

  const entries: PerformanceEntry[] = [];
  const measuredOperations: Array<{ started: number; ended: number }> = [];
  const observer = new PerformanceObserver((list) => {
    entries.push(...list.getEntries());
  });
  observer.observe({ type: 'longtask', buffered: false });
  return {
    supported: true,
    include: (started, ended) => measuredOperations.push({ started, ended }),
    maxDurationMs: () => {
      const durations = entries
        .filter((entry) =>
          measuredOperations.some(
            ({ started, ended }) =>
              entry.startTime <= started && entry.startTime + entry.duration >= ended,
          ),
        )
        .map((entry) => entry.duration);
      return durations.length === 0 ? 0 : Math.max(...durations);
    },
    async stop() {
      // Long-task entries are queued after the blocking task, so cross one task
      // boundary before taking the final records and disconnecting this arm only.
      await yieldToPaint();
      entries.push(...observer.takeRecords());
      observer.disconnect();
    },
  };
}

function prepareAppendPayloads(graph: GraphData, added: GraphData): AppendPayloads {
  return {
    added: cloneGraph(added),
    complete: cloneGraph(combineGraphs(graph, added)),
  };
}

function readUaMemoryWithTimeout(
  measure: () => Promise<{ bytes: number }>,
  phase: 'before' | 'after',
): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `${phase} measureUserAgentSpecificMemory read timed out after ${UA_MEMORY_TIMEOUT_MS}ms`,
        ),
      );
    }, UA_MEMORY_TIMEOUT_MS);

    // Attach both handlers to the browser promise immediately. If the timeout
    // wins, a later browser rejection is still consumed rather than becoming an
    // unhandled rejection.
    let pending: Promise<{ bytes: number }>;
    try {
      pending = measure();
    } catch (error) {
      settled = true;
      clearTimeout(timer);
      reject(error);
      return;
    }
    pending.then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result.bytes);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function observeLiveAppendMemory(
  arm: LayoutArm,
  graph: GraphData,
  added: GraphData,
): Promise<MemoryObservation> {
  const api = performance as unknown as MemoryApi;
  const windowApi = window as unknown as MemoryApi;
  const measureUserAgentMemory =
    api.measureUserAgentSpecificMemory ?? windowApi.measureUserAgentSpecificMemory;

  const observe = async (
    readBytes: (phase: 'before' | 'after') => Promise<number>,
    source: string,
    caveat: string,
    fallbackReason: string,
  ): Promise<MemoryObservation> => {
    // Keep the graph, append payloads, and live layout reachable across both
    // readings. Only the topology mutation occurs between the readings.
    const basePayload = cloneGraph(graph);
    const appendPayloads = prepareAppendPayloads(graph, added);
    const layout = arm.make();
    layout.setGraph(basePayload);
    layout.reheat(POST_TOPOLOGY_ALPHA);
    layout.step(WARMUP_TICKS);
    await yieldToPaint();
    try {
      const before = await readBytes('before');
      arm.append(layout, appendPayloads);
      const after = await readBytes('after');
      return {
        status: 'supported',
        source,
        deltaBytes: after - before,
        caveat,
        fallbackReason,
      };
    } finally {
      // Disposal is deliberately after both readings and outside the delta.
      layout.dispose();
    }
  };

  if (
    uaMemoryDisabledReason === null &&
    typeof measureUserAgentMemory === 'function' &&
    crossOriginIsolated
  ) {
    try {
      return await observe(
        (phase) => readUaMemoryWithTimeout(() => measureUserAgentMemory.call(performance), phase),
        'performance.measureUserAgentSpecificMemory',
        'Whole-agent memory observation; GC, unrelated agent activity, and measurement noise remain. This is not retained-memory or backend-selection evidence.',
        'none',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      uaMemoryDisabledReason = `disabled after UA-specific memory failure: ${message}`;
      // Retry the complete observation with a fresh layout and the heap fallback.
    }
  }

  const fallbackReason =
    uaMemoryDisabledReason ??
    (typeof measureUserAgentMemory !== 'function'
      ? 'measureUserAgentSpecificMemory unavailable'
      : 'measureUserAgentSpecificMemory requires cross-origin isolation');

  const readHeap = (): number | null => {
    const bytes = api.memory?.usedJSHeapSize;
    return typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : null;
  };
  if (readHeap() !== null) {
    return observe(
      async () => readHeap()!,
      'performance.memory.usedJSHeapSize',
      `Uncontrolled JS-heap fallback observation that may be quantized and affected by GC. Fallback reason: ${fallbackReason}. This is not retained-memory or backend-selection evidence.`,
      fallbackReason,
    );
  }

  return {
    status: 'unsupported',
    source: 'unsupported',
    deltaBytes: 'unsupported',
    caveat: `No usable browser memory observation API is available. UA-specific status: ${fallbackReason}.`,
    fallbackReason,
  };
}

async function warmup(arm: LayoutArm, graph: GraphData, added: GraphData): Promise<void> {
  const basePayload = cloneGraph(graph);
  const appendPayloads = prepareAppendPayloads(graph, added);
  const layout = arm.make();
  layout.setGraph(basePayload);
  layout.reheat(POST_TOPOLOGY_ALPHA);
  layout.step(WARMUP_TICKS);
  arm.append(layout, appendPayloads);
  layout.reheat(POST_TOPOLOGY_ALPHA);
  layout.step();
  layout.dispose();
  await yieldToPaint();
}

async function benchTicks(
  arm: LayoutArm,
  graph: GraphData,
  longTasks: LongTaskCapture,
): Promise<Samples> {
  const times: number[] = [];
  for (let trial = 0; trial < TRIALS; trial++) {
    const basePayload = cloneGraph(graph);
    const layout = arm.make();
    layout.setGraph(basePayload);
    layout.reheat(POST_TOPOLOGY_ALPHA);
    await yieldToPaint();
    for (let tick = 0; tick < TICKS; tick++) {
      const started = performance.now();
      layout.step();
      const ended = performance.now();
      times.push(ended - started);
      longTasks.include(started, ended);
      await yieldToPaint();
    }
    layout.dispose();
  }
  return summarize(times);
}

async function benchAppend(
  arm: LayoutArm,
  graph: GraphData,
  added: GraphData,
  longTasks: LongTaskCapture,
): Promise<AppendStats> {
  const appendTimes: number[] = [];
  const firstTickTimes: number[] = [];
  const settleStepTimes: number[] = [];
  const settleTimes: number[] = [];
  const settleTicks: number[] = [];
  let cappedTrials = 0;

  for (let trial = 0; trial < TRIALS; trial++) {
    // Both candidate payloads are fully cloned before timing. Each arm receives
    // only its declared payload, so cloning cost cannot favor appendGraph.
    const basePayload = cloneGraph(graph);
    const appendPayloads = prepareAppendPayloads(graph, added);
    const layout = arm.make();
    layout.setGraph(basePayload);
    layout.reheat(POST_TOPOLOGY_ALPHA);
    layout.step(WARMUP_TICKS);
    await yieldToPaint();

    let started = performance.now();
    arm.append(layout, appendPayloads);
    let ended = performance.now();
    appendTimes.push(ended - started);
    longTasks.include(started, ended);
    await yieldToPaint();

    // Topology-call timing above excludes reheating. Every arm starts the
    // post-topology tick and settling phases from the same explicit alpha.
    layout.reheat(POST_TOPOLOGY_ALPHA);
    started = performance.now();
    let active = layout.step();
    ended = performance.now();
    const firstTickMs = ended - started;
    firstTickTimes.push(firstTickMs);
    longTasks.include(started, ended);
    await yieldToPaint();

    let totalMs = firstTickMs;
    let ticks = 1;
    while (active && ticks < SETTLE_CAP) {
      started = performance.now();
      active = layout.step();
      ended = performance.now();
      const stepMs = ended - started;
      settleStepTimes.push(stepMs);
      longTasks.include(started, ended);
      totalMs += stepMs;
      ticks++;
      await yieldToPaint();
    }
    if (active) cappedTrials++;
    settleTimes.push(totalMs);
    settleTicks.push(ticks);
    layout.dispose();
    await yieldToPaint();
  }

  return {
    append: summarize(appendTimes),
    firstTick: summarize(firstTickTimes),
    settleTotal: summarize(settleTimes),
    settleTicksMedian: median(settleTicks),
    settleTicksP95: percentile(settleTicks, 0.95),
    settleCappedTrials: cappedTrials,
    maxStepMs: Math.max(...firstTickTimes, ...settleStepTimes),
  };
}

const arms: LayoutArm[] = [
  {
    name: 'd3-force-3d',
    dimensions: 3,
    appendMode: 'setGraph-rebuild',
    make: () => new D3ForceLayout(),
    append: (layout, payloads) => layout.setGraph(payloads.complete),
  },
  {
    name: 'vecto-force',
    dimensions: 3,
    appendMode: 'setGraph-rebuild',
    make: () => new VectoForceLayout(),
    append: (layout, payloads) => layout.setGraph(payloads.complete),
  },
  {
    name: 'd3-force-2d',
    dimensions: 2,
    appendMode: 'appendGraph',
    make: () => new D3Force2DLayout(),
    append: (layout, payloads) => (layout as D3Force2DLayout).appendGraph(payloads.added),
  },
  {
    name: 'force-layout-2d',
    dimensions: 2,
    appendMode: 'appendGraph',
    make: () =>
      new ForceLayout2D({
        repulsion: (node) => Number(node.charge ?? 300),
        collisionRadius: (node) => Number(node.radius ?? 0) + 14,
        collisionStrength: 0.7,
        linkDistance: (link) => {
          const source = Number(link.source);
          const target = Number(link.target);
          return 40 + (8 + (source % 5) + (8 + (target % 5))) * 1.5;
        },
        linkStrength: 0.42,
        centerStrength: 0.016,
        velocityDecay: 0.64,
        alphaDecay: 0.024,
        repulsionDistanceMax: 450,
        theta: 0.9,
        seed: 7,
      }),
    append: (layout, payloads) => (layout as ForceLayout2D).appendGraph(payloads.added),
  },
];

function rotatedArms(workloadIndex: number, countIndex: number): LayoutArm[] {
  const offset = (workloadIndex * COUNTS.length + countIndex) % arms.length;
  return [...arms.slice(offset), ...arms.slice(0, offset)];
}

async function main() {
  await awaitStart();
  const startedAt = performance.now();
  const progress = document.createElement('pre');
  document.body.appendChild(progress);
  const rows: Array<Record<string, string | number | boolean>> = [];
  const workloads = ['star-hub', 'mixed-sparse'] as const;

  for (let workloadIndex = 0; workloadIndex < workloads.length; workloadIndex++) {
    const workload = workloads[workloadIndex]!;
    for (let countIndex = 0; countIndex < COUNTS.length; countIndex++) {
      const count = COUNTS[countIndex]!;
      const graph = makeGraph(workload, count);
      const added = makeAppend(workload, count);
      const order = rotatedArms(workloadIndex, countIndex);
      for (let armIndex = 0; armIndex < order.length; armIndex++) {
        const arm = order[armIndex]!;
        progress.textContent = `${workload}: ${arm.name}, ${count} nodes`;
        await yieldToPaint();
        await warmup(arm, graph, added);

        const longTasks = captureLongTasks();
        const tick = await benchTicks(arm, graph, longTasks);
        const append = await benchAppend(arm, graph, added, longTasks);
        await longTasks.stop();
        const memory = await observeLiveAppendMemory(arm, graph, added);
        const longTaskMax = longTasks.maxDurationMs();
        const maxStepMs = Math.max(tick.maxMs, append.maxStepMs);

        rows.push({
          workload,
          layout: arm.name,
          dimensions: arm.dimensions,
          armOrder: armIndex,
          nodes: count,
          links: graph.links.length,
          tickSamples: tick.samples,
          tickMedianMs: +tick.medianMs.toFixed(4),
          tickP95Ms: +tick.p95Ms.toFixed(4),
          maxStepMs: +maxStepMs.toFixed(4),
          appendNodes: APPEND_NODES,
          appendLinks: added.links.length,
          appendMode: arm.appendMode,
          appendSamples: append.append.samples,
          appendMedianMs: +append.append.medianMs.toFixed(4),
          appendP95Ms: +append.append.p95Ms.toFixed(4),
          firstPostAppendTickMedianMs: +append.firstTick.medianMs.toFixed(4),
          firstPostAppendTickP95Ms: +append.firstTick.p95Ms.toFixed(4),
          settleTotalMedianMs: +append.settleTotal.medianMs.toFixed(4),
          settleTotalP95Ms: +append.settleTotal.p95Ms.toFixed(4),
          settleTicksMedian: +append.settleTicksMedian.toFixed(2),
          settleTicksP95: +append.settleTicksP95.toFixed(2),
          settleCappedTrials: append.settleCappedTrials,
          liveAppendMemoryObservationStatus: memory.status,
          liveAppendMemoryObservationSource: memory.source,
          liveAppendMemoryObservationDeltaBytes: memory.deltaBytes,
          liveAppendMemoryObservationCaveat: memory.caveat,
          liveAppendMemoryObservationFallbackReason: memory.fallbackReason,
          longTaskStatus: longTasks.supported ? 'supported' : 'unsupported',
          longTaskMaxDurationMs:
            typeof longTaskMax === 'number' ? +longTaskMax.toFixed(4) : longTaskMax,
        });
      }
    }
  }

  const result = await reportResult({
    name: 'graph-layout',
    params: {
      COUNTS,
      TICKS,
      TRIALS,
      SETTLE_CAP,
      UA_MEMORY_TIMEOUT_MS,
      APPEND_NODES,
      WARMUP_TICKS,
      POST_TOPOLOGY_ALPHA,
      workloads,
      armOrder: 'deterministic rotation per workload/count',
      appendTiming:
        'Measures appendGraph or setGraph topology mutation only; payload preparation and explicit post-topology reheat are excluded.',
      trialState:
        'Every append trial starts from a fresh deterministic layout reheated to POST_TOPOLOGY_ALPHA and stepped WARMUP_TICKS times; every first post-append tick and settling run is explicitly reheated to POST_TOPOLOGY_ALPHA after topology mutation.',
      stepTaskBoundaries:
        'Warmup is excluded. Every measured topology mutation and synchronous step is followed by an event-loop yield so long-task entries are not merged across operations.',
      maxStepDefinition:
        'Maximum raw duration of one synchronous step() call across regular ticks, first post-append ticks, and settling steps.',
      liveAppendMemoryObservation:
        'One dedicated warmed live layout per arm/workload/count is retained across immediate before/after topology-mutation readings, with payload creation and disposal outside the observation. measureUserAgentSpecificMemory is preferred and each read is bounded by UA_MEMORY_TIMEOUT_MS. Its first timeout or failure disables further UA-specific reads for the run; the failed observation is discarded and repeated with a fresh layout using performance.memory.usedJSHeapSize. Both sources are noisy observations, not retained-memory or backend-selection evidence.',
      baselineAvailability: {
        d3Force2D: 'direct d3-force@3.0.0 benchmark arm with explicit initial positions',
        d3Force3D: 'used via @vectojs/graph3d D3ForceLayout',
      },
      comparisonCaveat:
        'The 2D rows control dimensions, initial state, topology, and parameter scale, but compare different force laws: ForceLayout2D uses inverse-square repulsion and equal free/free collision shares; d3-force uses inverse-distance repulsion and radius-squared collision shares. Treat ratios as implementation-level workload comparisons, not equation-equivalent kernel measurements. The 3D rows are directional only.',
    },
    rows,
    durationMs: +(performance.now() - startedAt).toFixed(1),
    syntheticFrames: true,
  });
  progress.textContent = 'done';
  const output = document.createElement('pre');
  output.textContent = JSON.stringify(result, null, 2);
  document.body.appendChild(output);
}

main().catch((error) => reportFailure('graph-layout', error));
