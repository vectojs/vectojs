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
  host: HostInfo | null;
  startedAt: string;
  /** Wall-clock time the measured section took, for spotting a run that stalled. */
  durationMs: number;
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
 */
export function validateEnvironment(input: {
  refreshHz: number;
  crossOriginIsolated: boolean;
  viewport: ViewportInfo;
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
  return { ok: issues.length === 0, issues };
}
