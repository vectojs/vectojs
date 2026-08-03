/**
 * The one result shape every benchmark reports.
 *
 * Before this, 24 benchmarks emitted 24 envelopes. Only `name`, `engine` and
 * `userAgent` were universal; `runId` and `refreshHz` appeared in exactly one
 * benchmark each, `viewport` was a string in two, an array in one and an object
 * in two others, and `commit` was captured by the runner, echoed to the terminal
 * and then dropped. Cross-run aggregation was therefore impossible: there was no
 * shared key to join on and no way to tell which build a number came from.
 *
 * The point of a fixed envelope is not tidiness. It is that a number without its
 * commit, its measured refresh rate, its raster pixel count and its validation
 * state is not reproducible, and an irreproducible benchmark number is worse
 * than no number because it still gets quoted.
 */

/**
 * Incremented when a field changes meaning or is removed. Additive changes do
 * not bump it, so a reader can require `>=` a version and still accept newer
 * files.
 */
export const SCHEMA_VERSION = 1;

/** What the run was for. Profile-mode timings are not comparable to measure-mode. */
export type BenchmarkMode = 'measure' | 'profile';

/**
 * What `GET /host` returns: the host facts plus the commit of the tree that
 * built the bundle.
 *
 * The commit comes from the server rather than the URL because the runner already
 * had it, printed it to the terminal and then dropped it — every result file was
 * anonymous as to which build produced it. Reading it server-side also means a
 * hand-opened page gets it right without anyone remembering a query parameter.
 */
export interface HostResponse extends HostInfo {
  commit: string | null;
}

/** Static facts about the machine, supplied by the server (the page cannot see them). */
export interface HostInfo {
  /** CPU model string from /proc/cpuinfo. */
  cpu: string | null;
  /** Logical core count. */
  cores: number | null;
  /** GPU model, from nvidia-smi or the DRM device name. */
  gpu: string | null;
  /** GPU driver version, when discoverable. */
  driver: string | null;
  kernel: string | null;
  os: string | null;
  /**
   * The display's own refresh rate in Hz, from the compositor. `null` when it
   * could not be determined.
   *
   * This is the one number that makes a measured `refreshHz` checkable. A page
   * can measure the cadence it is *getting*, but it has no way to know the
   * cadence it *should* be getting: an unfocused window on an inactive Hyprland
   * workspace silently loses compositor frame callbacks and its rAF falls back to
   * a ~60 Hz timer while still reporting `visibilityState: 'visible'` and
   * `document.hasFocus() === true`. 60 Hz is a perfectly ordinary reading, so
   * without an external expectation nothing in the page or the envelope can tell
   * that run apart from a good one.
   *
   * On a host with mixed refresh rates this is the fastest enabled monitor, not
   * necessarily the one the benchmark window is on — the value is cached for the
   * server's lifetime and a window can move, so it is a property of the host
   * rather than of one window. That makes it usable for the check it exists for
   * ("did this page fall far below what this host can deliver") and unsuitable as
   * a per-window ground truth.
   */
  panelHz: number | null;
}

/** The viewport, in enough detail to reconstruct the rasterization workload. */
export interface ViewportInfo {
  /** CSS pixels. */
  width: number;
  height: number;
  dpr: number;
  /**
   * `width * height * dpr * dpr`. Recorded explicitly because a CSS viewport
   * alone is not a workload: 900x700 at DPR 2 is four times the pixels of DPR 1,
   * so two runs that look identically sized can differ 4x in raster cost.
   */
  rasterPixels: number;
}

/** One script that contributed to a retained Long Animation Frame. */
export interface LongAnimationFrameScriptAttribution {
  startTimeMs: number;
  durationMs: number;
  executionStartMs: number;
  forcedStyleAndLayoutDurationMs: number;
  pauseDurationMs: number;
  invoker: string;
  invokerType: string;
  sourceURL: string;
  sourceFunctionName: string;
  sourceCharPosition: number;
  windowAttribution: string;
}

/** One of the run's most blocking Long Animation Frames. */
export interface LongAnimationFrameRecord {
  startTimeMs: number;
  durationMs: number;
  blockingDurationMs: number;
  renderStartMs: number;
  styleAndLayoutStartMs: number;
  firstUIEventTimestampMs: number;
  scriptCount: number;
  droppedScripts: number;
  scripts: LongAnimationFrameScriptAttribution[];
}

/**
 * Bounded LoAF summary attached to every benchmark result.
 *
 * `reason: 'synthetic-frames'` means the benchmark drove frames itself with
 * `scene.step()` instead of `requestAnimationFrame`, so LoAF was measuring the
 * harness rather than the framework and the numbers are deliberately withheld.
 * See {@link ResultInput.syntheticFrames}.
 */
export interface LongAnimationFrameObservation {
  status: 'supported' | 'unavailable';
  reason: 'unsupported' | 'observer-error' | 'synthetic-frames' | null;
  entryCount: number;
  totalDurationMs: number;
  totalBlockingDurationMs: number;
  droppedEntries: number;
  entries: LongAnimationFrameRecord[];
}

/** Which browser, at which version. */
export interface BrowserInfo {
  /** `chrome` | `firefox` | `unknown`. */
  engine: string;
  /** Version string parsed from the UA, or null when unrecognized. */
  version: string | null;
  userAgent: string;
  /**
   * False means `performance.now()` is coarsened to ~100 us — the same order as
   * the costs most of these benchmarks measure. Treated as a validation failure.
   */
  crossOriginIsolated: boolean;
  /** `navigator.hardwareConcurrency`, which the page can see. */
  hardwareConcurrency: number | null;
}

/**
 * What the pre-run cadence gate found.
 *
 * Recorded in the envelope because a gate that only waits is barely better than no
 * gate: when it times out the run continues and still produces numbers, and this
 * block plus the validation issue it drives are the only things that tell those
 * numbers apart from good ones. Present only on runs whose page gated, so its
 * absence on an older file means "not gated", not "gate passed".
 */
export interface CadenceGateOutcome {
  /**
   * `reached` — cadence matched the panel before the deadline, the normal path.
   * `timeout` — it never did, so the run measured a throttled page and must not be
   * quoted. `skipped` — the gate did not apply; see `reason`.
   */
  status: 'reached' | 'timeout' | 'skipped';
  /** The rate the gate was waiting for, or null when it did not know one. */
  panelHz: number | null;
  /** The last cadence the gate sampled. 0 means no frames arrived at all. */
  observedHz: number;
  /** How long the gate waited before proceeding. */
  waitedMs: number;
  /** Why the gate was skipped or timed out; null when it simply succeeded. */
  reason: string | null;
}

/** Why a result should or should not be trusted. */
export interface ValidationBlock {
  /** True when `issues` is empty. */
  ok: boolean;
  /**
   * Human-readable reasons this run is suspect. Present and empty on a good run
   * rather than omitted, so a consumer can distinguish "validated, clean" from
   * "an old file that never validated anything".
   */
  issues: string[];
}

/** The envelope written to `results/history/` and `results/latest/`. */
export interface BenchmarkResult {
  schemaVersion: number;
  /** Unique per browser process. The result filename is keyed on this. */
  runId: string;
  /**
   * Shared by every process in one suite invocation, including every iteration
   * of every browser. This is the join key for cross-process aggregation.
   */
  suiteRunId: string;
  /** 1-based index within this browser's iterations. 1 when not iterating. */
  iteration: number;
  /** Short git SHA of the tree that produced the bundle. */
  commit: string | null;
  mode: BenchmarkMode;
  /**
   * `cold` = a fresh browser profile for this process, `warm` = a reused,
   * pre-heated one. Cold isolates but re-creates cache and font state every run.
   */
  profileState: 'cold' | 'warm';
  name: string;
  /** Retained at the top level: the server reads it to name the result file. */
  engine: string;
  /** Retained at the top level for the same reason as `engine`. */
  userAgent: string;
  browser: BrowserInfo;
  viewport: ViewportInfo;
  /** Measured rAF cadence. 0 means no frames arrived, which is a validation issue. */
  refreshHz: number;
  /**
   * What the pre-run cadence gate found, when the page ran one.
   *
   * Absent on a profile-mode run (the driver gate holds the page instead) and on
   * any result produced before the gate existed, so absence means "not gated"
   * rather than "gate passed".
   */
  cadenceGate?: CadenceGateOutcome;
  host: HostInfo | null;
  startedAt: string;
  /** Wall-clock time the measured section took, for spotting a run that stalled. */
  durationMs: number;
  /** Long frames observed during measured work; unavailable is expected in Firefox. */
  longAnimationFrames: LongAnimationFrameObservation;
  validation: ValidationBlock;
  /** Benchmark-specific workload dimensions. Shape is the benchmark's own. */
  params: Record<string, unknown>;
  /** Benchmark-specific measurements. Shape is the benchmark's own. */
  rows: unknown[];
  /**
   * A benchmark's derived headline figures, when it has any.
   *
   * Two benchmarks already reported a top-level `summary`, `glyph-batch` reported
   * `sustained`, and `hero-metrics` and `ui-perf` have no `rows` at all and hang
   * named sub-objects off the envelope instead. Without a slot for this, each of
   * them either loses the numbers it exists to produce or smuggles them into
   * `params`, where a reader looking for measurements will not find them.
   *
   * Deliberately untyped: it is per-benchmark by nature. It is separate from
   * `rows` so aggregation can ignore it — a derived figure recomputed from
   * aggregated rows is right, whereas a median of per-process derived figures is
   * a median of ratios, which is not the ratio of medians.
   */
  summary?: unknown;
  /**
   * Render-phase breakdown, when the benchmark captured one. Kept out of `rows`
   * so aggregation can find it without knowing the benchmark.
   */
  phases?: unknown;
  /**
   * Set when the benchmark threw. The rest of the envelope is still filled in,
   * unlike the previous failure path which dropped everything but the message.
   */
  failed?: true;
  error?: string;
}

/** Parse the browser version out of a user-agent string. */
export function browserVersionFromUa(ua: string): string | null {
  // Firefox first: its UA contains neither "Chrome" nor "Chromium", but Chrome's
  // contains "Safari", so testing in the other order mislabels it.
  const firefox = /Firefox\/([\d.]+)/.exec(ua);
  if (firefox) return firefox[1]!;
  const chrome = /(?:Chrome|Chromium)\/([\d.]+)/.exec(ua);
  if (chrome) return chrome[1]!;
  return null;
}

/** `chrome` | `firefox` | `unknown`, from a user-agent string. */
export function engineFromUa(ua: string): string {
  if (ua.includes('Firefox')) return 'firefox';
  if (ua.includes('Chrome') || ua.includes('Chromium')) return 'chrome';
  return 'unknown';
}

/**
 * How far *below* the panel rate a measured cadence may sit before it is a defect.
 *
 * Wide, because a page can legitimately read below panel rate: rAF is delivered at
 * display rate but a callback can be late, and the estimator's own hitch filter
 * only removes intervals beyond 2x the median. The failure it must catch is not
 * subtle — the focus cliff lands a 240 Hz panel at ~60 Hz, 75% low — so there is no
 * reason to sit anywhere near real measurement error, which is 0.025% (Gecko's
 * whole-millisecond rAF dither averages to 239.94 Hz on a 240 Hz panel).
 */
export const CADENCE_TOLERANCE = 0.1;

/**
 * How far *above* the panel rate a measured cadence may sit.
 *
 * Much tighter than {@link CADENCE_TOLERANCE}, and the asymmetry is physical
 * rather than a tuning choice: a page can genuinely receive fewer frames than the
 * display offers, but it cannot receive more. So the only thing that has to fit
 * under this bound is measurement error itself, and every over-read beyond it is a
 * broken estimator.
 *
 * 1% admits Gecko's 0.025% dither error with 40x of room and still catches the one
 * over-read that has actually happened: taking the median of that dither instead
 * of the mean reported 250 Hz on a 240 Hz panel, 4.2% high (fixed in #327). A
 * single tolerance cannot do both jobs — 10% would have let that artifact through.
 */
export const CADENCE_OVER_TOLERANCE = 0.01;

/**
 * Environmental checks applied to every run, whatever the benchmark measures.
 *
 * These are the conditions under which a number is not merely noisy but wrong,
 * and each one has actually happened:
 *
 *   * `refreshHz === 0` — no animation frames arrived at all, so any per-frame
 *     figure was divided by a denominator that does not exist.
 *   * not cross-origin isolated — the timer is coarsened to ~100 us and small
 *     costs quantize to 0 or to one tick.
 *   * `dpr` disagreeing with the raster pixel count — a mismatch means the
 *     envelope was assembled by hand and one of the two is stale.
 *   * `refreshHz` far from `panelHz` — the run measured a cadence the display does
 *     not have. Measured 2026-08-03: the same command at the same commit produced
 *     Firefox rows at 239.68 Hz and at 60.30 Hz, and the 60 Hz rows were not
 *     merely thinner samples — per-flush cost was worse and more variable
 *     (0.66-0.92 ms at 34-38% GPU utilization, against 0.62-0.64 ms at 64-72%).
 *     Such a row must be discarded rather than averaged, and before this check
 *     nothing in the file said so.
 */
export function validateEnvironment(input: {
  refreshHz: number;
  crossOriginIsolated: boolean;
  viewport: ViewportInfo;
  /** The display's own rate, when the server could determine it. */
  panelHz?: number | null;
}): ValidationBlock {
  const issues: string[] = [];
  if (input.refreshHz === 0) {
    issues.push(
      'refreshHz is 0: no animation frames were observed, so any per-frame figure is meaningless',
    );
  }
  if (!input.crossOriginIsolated) {
    issues.push(
      'not cross-origin isolated: performance.now() is coarsened to ~100us, comparable to the costs being measured',
    );
  }
  const expectedPixels =
    input.viewport.width * input.viewport.height * input.viewport.dpr * input.viewport.dpr;
  if (Math.abs(expectedPixels - input.viewport.rasterPixels) > 1) {
    issues.push('viewport.rasterPixels disagrees with width*height*dpr^2');
  }
  // Only meaningful when both are known. `refreshHz === 0` already has its own,
  // more specific issue above, so it is not also reported as a cadence mismatch.
  const panelHz = input.panelHz;
  if (typeof panelHz === 'number' && panelHz > 0 && input.refreshHz > 0) {
    const ratio = input.refreshHz / panelHz;
    if (ratio < 1 - CADENCE_TOLERANCE) {
      // Reported as lost frames rather than as a bad estimate: the frames really
      // did not arrive, so the per-frame figures describe a throttled run.
      issues.push(
        `refreshHz ${input.refreshHz.toFixed(2)} is far below the panel's ${panelHz.toFixed(2)}: ` +
          'the page did not receive frame callbacks at panel rate (typically an unfocused window), ' +
          'so its per-frame figures are not comparable and must not be quoted',
      );
    } else if (ratio > 1 + CADENCE_OVER_TOLERANCE) {
      // The opposite sign cannot be lost frames — no display delivers more frames
      // than its rate — so the estimator itself is wrong, which also invalidates
      // the expected-frame count the starvation check divides by.
      issues.push(
        `refreshHz ${input.refreshHz.toFixed(2)} exceeds the panel's ${panelHz.toFixed(2)}: ` +
          'the cadence estimate is wrong, so expected-frame counts derived from it are too',
      );
    }
  }
  return { ok: issues.length === 0, issues };
}
