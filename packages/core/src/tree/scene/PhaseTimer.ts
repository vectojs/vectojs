/**
 * Per-phase frame timing: which phase owned the frame, and how the samples add
 * up.
 *
 * A **shared leaf** of the `Scene.ts` decomposition rather than one of the six
 * domain collaborators. It is extracted ahead of extraction 3 because the
 * content-projection calibration pass records two of its own phases
 * (`calibScan`, `calibProbeBuild`) and cannot move while the only way to reach
 * the accumulator is `Scene._recordPhase`. Handing a collaborator
 * `scene._recordPhase.bind(scene)` would put a `Scene` reference inside a
 * closure, which is the violation of `DEC-0019` rule 1 that `DEC-0020` refused
 * for `syncA11y`. A shared object that nobody's `Scene` is reachable through has
 * neither problem: `Scene` owns one of these, and each collaborator that records
 * a phase holds the same instance.
 *
 * Nine methods across four domains read the enable flag today — the render walk,
 * the frame loop, the a11y sync, the content projection and its grid pass, the
 * calibration scheduler — so this would have had to become shared state at
 * whichever extraction reached it first regardless.
 *
 * ## Why totals rather than a log
 *
 * The question is always "which phase owns the frame". A per-frame log of
 * thousands of samples answers that less directly and costs far more memory.
 * `maxMs` is kept because a phase that is cheap on average but spikes is a
 * different problem from one that is uniformly slow.
 *
 * ## The disabled path must cost nothing
 *
 * These probes sit on the frame path, so {@link enabled} is a plain boolean field
 * and every call site is expected to test it before doing any timing work —
 * including the `performance.now()` calls themselves.
 */

/**
 * A timed phase of a frame.
 *
 * `render` is the ENCLOSING phase — it contains `transform`, `drawWalk` and
 * `flush` — so it is reported without a share to avoid double-counting.
 * `a11ySync` and `a11yOrder` run after `render` in the frame loop, so they are
 * siblings of it, not children.
 */
export type RenderPhase =
  | 'render'
  | 'transform'
  | 'drawWalk'
  | 'flush'
  | 'a11ySync'
  /**
   * Time inside {@link Scene.syncContentGridProjection} materializing DOM
   * carriers, nested inside `a11ySync`.
   *
   * Split out because `a11ySync` for a streaming code block measured 1661-1875 ms
   * against a 210-671 ms render, and attributing that to grid materialization was
   * an assumption. Nothing should be optimised here on the strength of the parent
   * phase alone.
   */
  | 'gridMaterialize'
  /**
   * Whole of {@link Scene.syncContentProjection}, nested inside `a11ySync`.
   *
   * Measured at 99.8-99.9% of `a11ySync` for a streaming code block, so per-node
   * a11y attribute and geometry work is not where that phase's cost lives.
   */
  | 'contentProjection'
  /** Per-node a11y attribute/geometry work, excluding content projection and descendants. */
  | 'a11yNodes'
  /** Whole of `syncContentGridProjection`, of which `gridMaterialize` is one part. */
  | 'gridSync'
  /**
   * Synchronous part of `scheduleContentGridCalibration` — building the probe DOM.
   *
   * The measurement itself is deferred to a rAF, but the probe is constructed
   * here. Measured at 77-80% of `gridSync` on Chrome (3.7-4.5 ms per frame, i.e.
   * the entire 240Hz budget) against about 1 ms on Firefox, making it the largest
   * remaining cost of projecting a streaming code block once carrier reuse landed.
   */
  | 'gridCalibrateSchedule'
  /** The `querySelectorAll` + per-cell scan inside calibration scheduling. */
  | 'calibScan'
  /** Probe DOM construction and insertion inside calibration scheduling. */
  | 'calibProbeBuild'
  | 'a11yOrder'
  /** Sum of every entity's own render(), nested inside drawWalk. */
  | 'entityPaint';

export interface RenderPhaseEntry {
  phase: RenderPhase;
  totalMs: number;
  calls: number;
  avgMs: number;
  /** Worst single sample — a spiky phase is a different problem from a slow one. */
  maxMs: number;
  /** Percent of the measured total, or `null` for the enclosing `render` phase. */
  share: number | null;
}

export class PhaseTimer {
  /**
   * Whether per-phase timing is being recorded.
   *
   * A field rather than an accessor: it is tested on the frame path once per
   * probe, and the disabled cost has to be a single boolean read.
   */
  public enabled = false;
  /** Whether browser User Timing instrumentation is enabled. */
  public userTiming = false;

  private readonly totals = new Map<
    RenderPhase,
    { totalMs: number; calls: number; maxMs: number }
  >();

  /** Start or stop recording. Disabling also drops what was collected. */
  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.clear();
  }

  /** Accumulate one phase sample. */
  public record(phase: RenderPhase, ms: number): void {
    const existing = this.totals.get(phase);
    if (existing) {
      existing.totalMs += ms;
      existing.calls++;
      if (ms > existing.maxMs) existing.maxMs = ms;
      return;
    }
    this.totals.set(phase, { totalMs: ms, calls: 1, maxMs: ms });
  }

  /**
   * Recorded phase timings, most expensive first, with each phase's share of the
   * measured total.
   *
   * `share` is the number that matters: a phase at 4% cannot be worth optimising
   * however inefficient it looks in isolation.
   */
  public get entries(): RenderPhaseEntry[] {
    const entries = [...this.totals.entries()];
    // `render` is the enclosing phase for transform/drawWalk/flush, so counting
    // it in the denominator would double-count and halve every share.
    const denominator = entries
      .filter(([phase]) => phase !== 'render')
      .reduce((sum, [, v]) => sum + v.totalMs, 0);
    return entries
      .map(([phase, v]) => ({
        phase,
        totalMs: +v.totalMs.toFixed(3),
        calls: v.calls,
        avgMs: +(v.totalMs / Math.max(1, v.calls)).toFixed(4),
        maxMs: +v.maxMs.toFixed(3),
        share:
          phase === 'render' ? null : +((100 * v.totalMs) / Math.max(1e-9, denominator)).toFixed(1),
      }))
      .sort((a, b) => b.totalMs - a.totalMs);
  }

  /** Drop recorded timings, keeping recording enabled. */
  public clear(): void {
    this.totals.clear();
  }
}
