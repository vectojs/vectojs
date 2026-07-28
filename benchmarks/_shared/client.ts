/**
 * In-page helpers shared by every benchmark entry.
 *
 * The important one is {@link calibrateRefreshRate}. Starvation detection compared
 * the frames a run actually got against a hardcoded 60 Hz expectation, on a
 * display that runs at 240. Four seconds offers ~960 frames there, not 240, so the
 * 25% floor sat at 60 frames — a run starved down to 100 frames passed the check
 * and its per-frame figures, computed against a collapsed denominator, looked like
 * a large win. That is the exact failure mode the starvation flag exists to catch,
 * and the hardcode made it blind to the severe cases while still catching trivial
 * ones.
 */

/** Result payload fields every benchmark reports, so runs can be correlated. */
export interface BenchmarkEnvelope {
  /** Correlates this result with the runner invocation that asked for it. */
  runId: string;
  name: string;
  engine: string;
  userAgent: string;
  /** Measured rAF rate, not assumed. */
  refreshHz: number;
  /** CSS viewport and DPR: raster pixel count is width × height × dpr². */
  viewport: { width: number; height: number; dpr: number };
  screen: { width: number; height: number };
  startedAt: string;
  rows: unknown[];
}

/**
 * Measure the real rAF cadence by sampling frame intervals.
 *
 * Uses the median rather than the mean: a single long frame from a GC pause or a
 * compositor hitch would drag a mean down and understate the display rate, which
 * would then understate the expected frame count and hide starvation — the very
 * thing this feeds.
 */
export function calibrateRefreshRate(durationMs = 1000): Promise<number> {
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
  const fromUrl = new URLSearchParams(location.search).get('runId');
  if (fromUrl) return fromUrl;
  // A hand-opened page still gets a unique id, so a manual run cannot overwrite
  // an automated one in history/.
  return `manual-${Date.now().toString(36)}`;
}

/** Chrome-only: frames that blocked for >50 ms, with script attribution. */
export function observeLongAnimationFrames(): { entries: PerformanceEntry[] } {
  const entries: PerformanceEntry[] = [];
  const supported = PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame');
  if (supported) {
    // Firefox does not implement this, so its absence is expected rather than a
    // fault; the field is simply empty there.
    const observer = new PerformanceObserver((list) => entries.push(...list.getEntries()));
    observer.observe({
      type: 'long-animation-frame',
      buffered: true,
    } as PerformanceObserverInit);
  }
  return { entries };
}

/** Engine name from the user agent. Only Chrome and Firefox are driven. */
export function engineName(): string {
  const ua = navigator.userAgent;
  if (ua.includes('Firefox')) return 'firefox';
  if (ua.includes('Chrome')) return 'chrome';
  return 'unknown';
}

/**
 * Build the standard envelope around a benchmark's own rows.
 *
 * Calibration runs here rather than in each entry so every benchmark reports a
 * measured `refreshHz` without having to remember to.
 */
export async function buildEnvelope(
  name: string,
  rows: unknown[],
  options: { calibrateMs?: number } = {},
): Promise<BenchmarkEnvelope> {
  const refreshHz = await calibrateRefreshRate(options.calibrateMs ?? 1000);
  return {
    runId: runIdFromUrl(),
    name,
    engine: engineName(),
    userAgent: navigator.userAgent,
    refreshHz: Math.round(refreshHz * 100) / 100,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio,
    },
    screen: { width: screen.width, height: screen.height },
    startedAt: new Date().toISOString(),
    rows,
  };
}

/** POST the envelope to the benchmark server. */
export async function postResults(payload: BenchmarkEnvelope): Promise<void> {
  await fetch('/results', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}
