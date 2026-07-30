/**
 * In-page helpers shared by every benchmark entry.
 *
 * Two things here are load-bearing.
 *
 * {@link calibrateRefreshRate} — starvation detection once compared the frames a
 * run actually got against a hardcoded 60 Hz expectation, on a display that runs
 * at 240. Four seconds offers ~960 frames there, not 240, so the 25% floor sat at
 * 60 frames: a run starved down to 100 frames passed the check and its per-frame
 * figures, computed against a collapsed denominator, looked like a large win.
 * That is exactly what the starvation flag exists to catch, and the hardcode made
 * it blind to the severe cases while still catching trivial ones. The two engines
 * do not even agree on the same panel — measured 240.1 Hz on Chrome against
 * 58.75 Hz on Firefox — so 60 was accidentally right for one and wrong by 4x for
 * the other.
 *
 * {@link awaitStart} — the page used to begin measuring the instant it loaded,
 * which makes a profiler useless: attaching a Chrome trace or a Gecko profile
 * takes long enough that the run is half over before recording starts, and the
 * first measured interval races the window focus the runner is still applying.
 * In `profile` mode the page now waits to be told to start.
 */

import {
  observeLongAnimationFrames,
  unavailableObservation,
  type LongAnimationFrameCollector,
} from './loaf.ts';
import {
  browserVersionFromUa,
  engineFromUa,
  SCHEMA_VERSION,
  validateEnvironment,
  type BenchmarkMode,
  type BenchmarkResult,
  type HostResponse,
  type ViewportInfo,
} from './schema.ts';

export type { BenchmarkMode, BenchmarkResult } from './schema.ts';

/** Everything the runner passes in the URL. */
export interface RunContext {
  runId: string;
  suiteRunId: string;
  iteration: number;
  mode: BenchmarkMode;
  profileState: 'cold' | 'warm';
  /**
   * Whether the page must wait to be told to start.
   *
   * Separate from `mode` on purpose, because the two profilers need opposite
   * things. A Chrome CDP trace is attached after the page has loaded, so the page
   * has to wait or the run is half over before recording starts. Firefox's
   * profiler is started by `MOZ_PROFILER_STARTUP=1` before the process even
   * launches, so gating there would only add an idle window to the profile.
   */
  gate: boolean;
}

/**
 * The control surface the runner drives.
 *
 * Exposed as `window.__VECTO_BENCH__` so a CDP or WebDriver session can start a
 * run at a moment of its choosing, and can tell completion from a page that is
 * merely still open.
 */
export interface BenchmarkControl {
  /** Release a page waiting in {@link awaitStart}. Idempotent. */
  start(): void;
  /** True once the benchmark has posted its result. */
  done: boolean;
  /** The posted result, for a driver that would rather read it than the file. */
  result: BenchmarkResult | null;
  /** Set when the benchmark threw. */
  error: string | null;
  /** Run context parsed from the URL. */
  context: RunContext;
}

declare global {
  interface Window {
    __VECTO_BENCH__?: BenchmarkControl;
  }
}

/** Read the run context out of the URL, with defaults for a hand-opened page. */
export function readRunContext(search: string = location.search): RunContext {
  const p = new URLSearchParams(search);
  const runId = p.get('runId') ?? `manual-${Date.now().toString(36)}`;
  const modeParam = p.get('mode');
  // Anything unrecognized is treated as `measure`: a typo must not silently
  // produce profile-mode timings and have them quoted as measurements.
  const mode: BenchmarkMode = modeParam === 'profile' ? 'profile' : 'measure';
  const iteration = Number.parseInt(p.get('iteration') ?? '1', 10);
  return {
    runId,
    // Falls back to the runId so a manually opened page still has a join key.
    suiteRunId: p.get('suiteRunId') ?? runId,
    iteration: Number.isFinite(iteration) && iteration > 0 ? iteration : 1,
    mode,
    profileState: p.get('profileState') === 'warm' ? 'warm' : 'cold',
    // Opt-in only. A page that waits when nothing is coming to start it hangs
    // until the runner's timeout, so this defaults off and the runner sets it
    // exactly for the Chrome profile path that does attach a driver.
    gate: p.get('gate') === '1',
  };
}

let control: BenchmarkControl | null = null;
let startSignal: Promise<void> | null = null;
let releaseStart: (() => void) | null = null;
let longAnimationFrameCollector: LongAnimationFrameCollector | null = null;

/**
 * Install `window.__VECTO_BENCH__` and return it.
 *
 * Called automatically by {@link awaitStart}; call it directly only if the page
 * needs the control surface to exist before it starts waiting.
 */
export function installControl(context: RunContext = readRunContext()): BenchmarkControl {
  if (control) return control;
  startSignal = new Promise<void>((resolvePromise) => {
    releaseStart = resolvePromise;
  });
  control = {
    start(): void {
      releaseStart?.();
      releaseStart = null;
    },
    done: false,
    result: null,
    error: null,
    context,
  };
  if (typeof window !== 'undefined') window.__VECTO_BENCH__ = control;
  return control;
}

/**
 * Resolve when the benchmark should begin.
 *
 * Without `gate=1` this returns immediately, so the default path is byte-for-byte
 * the behaviour every benchmark had before and no existing measurement moves.
 * With it, the page waits for `window.__VECTO_BENCH__.start()` so a driver can
 * attach its tracer to a loaded but idle page.
 *
 * A gated page that is never started stays open until the runner's timeout, which
 * is the correct failure: measuring anyway, without the profiler attached, would
 * produce a result file indistinguishable from a good one.
 *
 * Call this at the top of a benchmark's `main()`, before any measurement:
 *
 * ```ts
 * const context = await awaitStart();
 * ```
 */
export async function awaitStart(context: RunContext = readRunContext()): Promise<RunContext> {
  installControl(context);
  if (context.gate) await startSignal;
  longAnimationFrameCollector ??= observeLongAnimationFrames();
  return context;
}

/**
 * The first calibration performed on this page, reused by every later caller.
 *
 * A page calibrated twice — once for its own `expectedFrames`, then again inside
 * {@link buildResult} — and the two disagreed: a Firefox run reported 58.75 Hz to
 * its rows and 250 Hz in its envelope, from the same page on the same panel. The
 * envelope's copy is what a reader quotes and what validation checks, so the
 * result advertised a cadence no arm was measured against.
 *
 * A rAF sample taken right after navigation is not a steady-state sample. A probe
 * bucketing intervals over 6 s showed Chrome's first 500 ms bucket at 60.01 Hz
 * before settling at 240.1 Hz for every subsequent bucket, and Firefox steady at
 * 58.75 Hz throughout — so the fix is not a longer sample but a single sample,
 * taken once, at a defined point.
 */
let cachedRefreshHz: Promise<number> | null = null;

/**
 * Measure the real rAF cadence by sampling frame intervals.
 *
 * Uses the median rather than the mean: a single long frame from a GC pause or a
 * compositor hitch would drag a mean down and understate the display rate, which
 * would then understate the expected frame count and hide starvation — the very
 * thing this feeds.
 *
 * Cached per page: the first call measures and every later one reuses that
 * measurement, so a benchmark's rows and its envelope can never quote two
 * different cadences. Pass `force` to deliberately re-measure.
 */
export function calibrateRefreshRate(durationMs = 1000, force = false): Promise<number> {
  if (!force && cachedRefreshHz !== null) return cachedRefreshHz;
  const measured = measureRefreshRate(durationMs);
  // A zero result means "not measured" (no frames, or a non-positive budget) and
  // must not be cached as though it were a reading.
  if (durationMs > 0) {
    cachedRefreshHz = measured.then((hz) => {
      if (hz === 0) cachedRefreshHz = null;
      return hz;
    });
    return cachedRefreshHz;
  }
  return measured;
}

/** Reset the cached cadence. Exists for tests. */
export function resetRefreshRateCache(): void {
  cachedRefreshHz = null;
}

function measureRefreshRate(durationMs: number): Promise<number> {
  // A non-positive budget means "do not calibrate" and must not await a frame at
  // all. The failure path uses this: a page that threw during setup may never
  // produce another frame, and a rAF that never fires would hang the failure
  // report — turning a clean error report back into the timeout it replaced.
  if (durationMs <= 0) return Promise.resolve(0);
  return new Promise((resolvePromise) => {
    const intervals: number[] = [];
    let previous = performance.now();
    const end = previous + durationMs;

    const frame = (now: number): void => {
      const delta = now - previous;
      previous = now;
      // Discard the first interval and any absurd one: the first frame after a
      // navigation is not a steady-state interval.
      if (delta > 0.1 && delta < 200) intervals.push(delta);
      if (now < end) {
        requestAnimationFrame(frame);
        return;
      }
      if (intervals.length === 0) {
        // No frames at all: report 0 so callers can distinguish "not measured"
        // from a plausible-looking default.
        resolvePromise(0);
        return;
      }
      intervals.sort((a, b) => a - b);
      const median = intervals[Math.floor(intervals.length / 2)]!;
      resolvePromise(1000 / median);
    };
    requestAnimationFrame(frame);
  });
}

/** The runId the runner passed in the URL, or a local fallback for a manual open. */
export function runIdFromUrl(): string {
  return readRunContext().runId;
}

/** Engine name from the user agent. Only Chrome and Firefox are driven. */
export function engineName(): string {
  return engineFromUa(navigator.userAgent);
}

/** The current viewport, including the raster pixel count DPR implies. */
export function readViewport(): ViewportInfo {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const dpr = window.devicePixelRatio;
  return {
    width,
    height,
    dpr,
    rasterPixels: Math.round(width * height * dpr * dpr),
  };
}

/**
 * Fetch static host facts from the server.
 *
 * The page cannot see the CPU model, the GPU or the driver version, and a result
 * without them cannot be compared across machines. Returns null rather than
 * throwing when the server does not offer the endpoint, so an older bench
 * directory still produces a valid result.
 */
export async function fetchHostInfo(): Promise<HostResponse | null> {
  try {
    const response = await fetch('/host');
    if (!response.ok) return null;
    return (await response.json()) as HostResponse;
  } catch {
    return null;
  }
}

/** What a benchmark supplies; everything else in the envelope is filled in here. */
export interface ResultInput {
  name: string;
  params?: Record<string, unknown>;
  rows?: unknown[];
  /**
   * Derived headline figures. Use this rather than hiding them in `params`: a
   * reader looking for measurements does not read the workload description.
   */
  summary?: unknown;
  phases?: unknown;
  /** Wall-clock ms the measured section took. */
  durationMs?: number;
  /** Extra validation problems the benchmark itself detected. */
  issues?: string[];
  /**
   * Set when the benchmark drives frames itself with `scene.step()` rather than
   * `requestAnimationFrame`, which makes the LoAF observation meaningless.
   *
   * LoAF measures real animation frames. A benchmark that advances the scene in a
   * tight synchronous loop has no animation frames to measure: the whole loop is
   * ONE long task, so LoAF faithfully reports the harness's own blocking and says
   * nothing about the framework. Measured on `markdown-transcript` (CTX-0148/0149):
   * 5 entries totalling 27,510 ms of blocking against a 5,547 ms median trial —
   * 4.96x, because each entry was one entire trial of 6,543 un-yielded appends,
   * confirmed one-for-one against the instrumented per-trial span.
   *
   * That number invites exactly the wrong conclusion, so setting this replaces the
   * observation with `unavailable`/`synthetic-frames` instead of publishing it.
   * Yielding inside the loop to create real frames is NOT the fix: it would change
   * what the benchmark measures and break comparability with its own baseline.
   */
  syntheticFrames?: boolean;
  failed?: true;
  error?: string;
}

/**
 * Build the full result envelope.
 *
 * Calibration and host lookup happen here rather than in each entry, so every
 * benchmark reports a measured `refreshHz` and a machine identity without having
 * to remember to. That is the whole reason this is centralized: the previous
 * arrangement asked 24 entries to each assemble their own envelope, and exactly
 * one of them ended up reporting a refresh rate.
 */
export async function buildResult(
  input: ResultInput,
  options: {
    calibrateMs?: number;
    context?: RunContext;
  } = {},
): Promise<BenchmarkResult> {
  // Always finish the collector, even when the result is withheld: it disconnects
  // the observer, and leaving it live would leak it across a multi-iteration run.
  const observed = (longAnimationFrameCollector ??= observeLongAnimationFrames()).finish();
  const longAnimationFrames = input.syntheticFrames
    ? unavailableObservation('synthetic-frames')
    : observed;
  const context = options.context ?? readRunContext();
  const refreshHz = await calibrateRefreshRate(options.calibrateMs ?? 1000);
  const host = await fetchHostInfo();
  const viewport = readViewport();
  const isolated = typeof crossOriginIsolated === 'boolean' ? crossOriginIsolated : false;
  const environment = validateEnvironment({
    refreshHz,
    crossOriginIsolated: isolated,
    viewport,
  });
  const issues = [...environment.issues, ...(input.issues ?? [])];
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: context.runId,
    suiteRunId: context.suiteRunId,
    iteration: context.iteration,
    commit: host?.commit ?? null,
    mode: context.mode,
    profileState: context.profileState,
    name: input.name,
    engine: engineName(),
    userAgent: navigator.userAgent,
    browser: {
      engine: engineName(),
      version: browserVersionFromUa(navigator.userAgent),
      userAgent: navigator.userAgent,
      crossOriginIsolated: isolated,
      hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    },
    viewport,
    refreshHz: Math.round(refreshHz * 100) / 100,
    host,
    startedAt: new Date().toISOString(),
    durationMs: input.durationMs ?? 0,
    longAnimationFrames,
    validation: { ok: issues.length === 0, issues },
    params: input.params ?? {},
    rows: input.rows ?? [],
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    ...(input.phases === undefined ? {} : { phases: input.phases }),
    ...(input.failed ? { failed: true as const } : {}),
    ...(input.error === undefined ? {} : { error: input.error }),
  };
}

/**
 * POST a result to the benchmark server and mark the run done.
 *
 * Never throws. Each benchmark used to wrap this in its own try/catch for one
 * reason: a failed POST must not stop the page from calling `window.close()`,
 * because a page left open is indistinguishable from a hang and burns the
 * runner's full timeout — 60 s plus a 180 s extension per browser. Swallowing
 * here means no benchmark has to remember that, and none can get it wrong.
 *
 * A failure is reported on the control surface and to the console rather than
 * silently: the result file simply will not appear, which the runner already
 * treats as a failure.
 */
export async function postResults(payload: BenchmarkResult): Promise<void> {
  try {
    await fetch('/results', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (control) {
      control.done = true;
      control.result = payload;
      if (payload.error !== undefined) control.error = payload.error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (control) control.error = `failed to post results: ${message}`;
    console.error('failed to post results:', message);
  }
}

/**
 * Build and post in one call, reporting a thrown benchmark as a failed result.
 *
 * A benchmark that throws after measuring used to leave the page open and burn
 * the runner's full timeout, which is indistinguishable from a hang — and the one
 * benchmark that did post on failure dropped every field except the message. This
 * posts a complete envelope with `failed: true`, so a failure is visible
 * immediately and still carries its environment.
 */
export async function reportResult(input: ResultInput): Promise<BenchmarkResult> {
  const result = await buildResult(input);
  await postResults(result);
  return result;
}

/** Report a thrown error as a valid, failed result. */
export async function reportFailure(name: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (control) control.error = message;
  try {
    await postResults(
      await buildResult(
        {
          name,
          failed: true,
          error: message,
          issues: [`benchmark threw: ${message}`],
          // Skip calibration on the failure path: a page that threw during setup
          // may not be producing frames at all, and waiting a second for a refresh
          // rate nobody will read only delays the report.
        },
        { calibrateMs: 0 },
      ),
    );
  } catch {
    // The server may be gone; there is nowhere left to report to.
  }
}
