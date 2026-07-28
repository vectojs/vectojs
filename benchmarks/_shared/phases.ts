/**
 * Capture a scene's render-phase breakdown, generically.
 *
 * This exists because the enumerative alternative has now failed twice in the
 * same way. `ondemand-raf` originally reported two of the phases it could have —
 * `render` and `entityPaint` — and entity paint turned out to be 26% of render on
 * Chrome, so three quarters of the cost sat in phases the benchmark never looked
 * at. It was fixed by hand-writing 13 named fields; that list is still missing
 * `a11yNodes`. `markdown-stream-phases` independently hand-wrote a 7-name subset
 * and silently drops the other 7. A hand-maintained name list drifts from the
 * engine every time a phase is added, and the drift is invisible: the missing
 * phase does not show up as a gap, it shows up as a total that does not add up,
 * which nobody checks.
 *
 * So: read whatever `scene.renderPhases` reports, keep all of it, and record the
 * nesting relationships alongside it so shares can be recomputed downstream
 * without re-deriving which phase encloses which.
 */

/** One phase as the engine reports it. Mirrors core's `RenderPhaseEntry`. */
export interface PhaseEntry {
  phase: string;
  totalMs: number;
  calls: number;
  avgMs: number;
  maxMs: number;
  share: number | null;
}

/** The minimum of `Scene` this module needs, so benchmarks need not import core. */
export interface PhaseSource {
  readonly renderPhases: readonly PhaseEntry[];
  setPhaseTiming(enabled: boolean): void;
  clearRenderPhases(): void;
}

/**
 * Which phase encloses which, as verified at the `_recordPhase` call sites in
 * `packages/core/src/tree/Scene.ts` — not from the doc comments, which describe
 * `gridMaterialize` as nested in `a11ySync` without mentioning the two
 * intermediate levels.
 *
 * A phase absent from this map is top-level. `render`, `a11ySync` and `a11yOrder`
 * are siblings in the frame loop.
 *
 * Why it matters: summing every phase double-counts, because a parent's total
 * already contains its children's. `entityPaint + drawWalk` is not a cost, it is
 * `drawWalk` plus part of itself.
 */
export const PHASE_PARENT: Readonly<Record<string, string>> = {
  transform: 'render',
  drawWalk: 'render',
  flush: 'render',
  entityPaint: 'drawWalk',
  a11yNodes: 'a11ySync',
  contentProjection: 'a11ySync',
  gridSync: 'contentProjection',
  gridMaterialize: 'gridSync',
  gridCalibrateSchedule: 'gridSync',
  calibScan: 'gridCalibrateSchedule',
  calibProbeBuild: 'gridCalibrateSchedule',
};

/** A phase with its nesting made explicit and its own cost separated out. */
export interface PhaseReport extends PhaseEntry {
  /** Enclosing phase, or null when top-level. */
  parent: string | null;
  /**
   * `totalMs` minus the totals of this phase's direct children: the cost
   * attributable to this phase itself. This is the number to optimise against;
   * `totalMs` on a parent phase mostly measures its children.
   */
  selfMs: number;
  /**
   * `selfMs` as a percent of the frame's total self time.
   *
   * Prefer this over the engine's `share`. That one divides by the sum of every
   * phase except `render`, which still includes nested phases, so a child is
   * counted once on its own and again inside its parent and the shares do not
   * sum to 100. `selfShare` partitions the frame exactly.
   */
  selfShare: number;
}

/** The captured breakdown. */
export interface PhaseCapture {
  /**
   * Every phase the engine reported, unfiltered. New engine phases appear here
   * automatically without touching any benchmark.
   */
  entries: PhaseReport[];
  /**
   * Sum of `selfMs` across top-level phases — the frame's total measured cost
   * with no double-counting. Compare against `render` + `a11ySync` + `a11yOrder`.
   */
  totalSelfMs: number;
  /** Phases the engine defines but did not report, i.e. never executed. */
  missing: string[];
}

/**
 * Every phase `RenderPhase` can be, as of core 1.23.0.
 *
 * Used only to report which phases were *not* exercised by a run — a phase at
 * zero because the workload never triggered it is a different fact from a phase
 * that was never instrumented, and the difference decides whether a benchmark is
 * covering what it claims to.
 *
 * A phase the engine reports but this list omits is not dropped; the list is for
 * detecting absence, and {@link capturePhases} never filters by it.
 */
export const KNOWN_PHASES: readonly string[] = [
  'render',
  'transform',
  'drawWalk',
  'flush',
  'entityPaint',
  'a11ySync',
  'a11yNodes',
  'contentProjection',
  'gridSync',
  'gridMaterialize',
  'gridCalibrateSchedule',
  'calibScan',
  'calibProbeBuild',
  'a11yOrder',
];

/** Build a report from raw phase entries. Pure, so it is directly testable. */
export function buildPhaseReport(entries: readonly PhaseEntry[]): PhaseCapture {
  const totals = new Map<string, number>();
  for (const e of entries) totals.set(e.phase, e.totalMs);

  const childSum = new Map<string, number>();
  for (const e of entries) {
    const parent = PHASE_PARENT[e.phase];
    if (parent !== undefined) {
      childSum.set(parent, (childSum.get(parent) ?? 0) + e.totalMs);
    }
  }

  const withSelf = entries.map((e) => ({
    ...e,
    parent: PHASE_PARENT[e.phase] ?? null,
    // Clamped at 0: children are timed inside the parent's window, but each
    // performance.now() pair carries its own overhead, so a parent whose cost is
    // almost entirely one child can measure a hair under the sum. A negative
    // self-time is a measurement artefact, not information.
    selfMs: +Math.max(0, e.totalMs - (childSum.get(e.phase) ?? 0)).toFixed(4),
  }));

  const totalSelfMs = +withSelf.reduce((sum, r) => sum + r.selfMs, 0).toFixed(4);
  const reports: PhaseReport[] = withSelf.map((r) => ({
    ...r,
    selfShare: totalSelfMs === 0 ? 0 : +((100 * r.selfMs) / totalSelfMs).toFixed(2),
  }));

  return {
    entries: reports,
    totalSelfMs,
    missing: KNOWN_PHASES.filter((p) => !totals.has(p)),
  };
}

/** Read the current breakdown off a scene. Does not disable timing. */
export function capturePhases(scene: PhaseSource): PhaseCapture {
  return buildPhaseReport(scene.renderPhases);
}

/**
 * Turn phase timing on and clear anything already recorded.
 *
 * Clearing matters per arm: phase totals accumulate, so an arm measured after
 * another without a clear reports the sum of both and every share is wrong.
 */
export function beginPhaseCapture(scene: PhaseSource): void {
  scene.setPhaseTiming(true);
  scene.clearRenderPhases();
}

/** Read the breakdown and turn timing back off. */
export function endPhaseCapture(scene: PhaseSource): PhaseCapture {
  const capture = capturePhases(scene);
  scene.setPhaseTiming(false);
  return capture;
}

/**
 * Median-combine several captures of the same arm, matching phases by name.
 *
 * Per-phase medians across trials, rather than the phases of the median trial:
 * one trial's `flush` spiking does not then distort its `transform`.
 */
export function medianPhaseCapture(captures: readonly PhaseCapture[]): PhaseCapture {
  if (captures.length === 0) return { entries: [], totalSelfMs: 0, missing: [...KNOWN_PHASES] };
  const byPhase = new Map<string, PhaseReport[]>();
  for (const c of captures) {
    for (const e of c.entries) {
      const list = byPhase.get(e.phase);
      if (list) list.push(e);
      else byPhase.set(e.phase, [e]);
    }
  }
  const mid = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  };
  const entries: PhaseEntry[] = [...byPhase.entries()].map(([phase, list]) => ({
    phase,
    totalMs: +mid(list.map((x) => x.totalMs)).toFixed(4),
    calls: Math.round(mid(list.map((x) => x.calls))),
    avgMs: +mid(list.map((x) => x.avgMs)).toFixed(4),
    maxMs: +mid(list.map((x) => x.maxMs)).toFixed(4),
    share: null,
  }));
  // Rebuild from the medianed totals so selfMs and shares stay internally
  // consistent with the numbers actually reported.
  return buildPhaseReport(entries);
}
