import { expect, test } from 'bun:test';
import {
  awaitCadence,
  awaitStart,
  calibrateRefreshRate,
  fetchHostInfo,
  readRunContext,
  resetCadenceGate,
  resetHostInfoCache,
  resetRefreshRateCache,
} from './client.ts';

test('a runner-supplied context is read from the query string', () => {
  const c = readRunContext(
    '?runId=20260728T120000Z-abc-chrome-i2&suiteRunId=20260728T120000Z-abc&iteration=2&mode=profile&profileState=warm',
  );
  expect(c.runId).toBe('20260728T120000Z-abc-chrome-i2');
  expect(c.suiteRunId).toBe('20260728T120000Z-abc');
  expect(c.iteration).toBe(2);
  expect(c.mode).toBe('profile');
  expect(c.profileState).toBe('warm');
});

test('a hand-opened page still gets a unique runId', () => {
  // Without this a manual run overwrites an automated one in history/.
  const a = readRunContext('');
  expect(a.runId).toStartWith('manual-');
  expect(a.iteration).toBe(1);
  expect(a.mode).toBe('measure');
  expect(a.profileState).toBe('cold');
});

test('suiteRunId falls back to runId so there is always a join key', () => {
  const c = readRunContext('?runId=solo-run');
  expect(c.suiteRunId).toBe('solo-run');
});

test('an unrecognized mode falls back to measure', () => {
  // A typo must not silently yield profile-mode timings that then get quoted as
  // measurements; profiler overhead makes the two incomparable.
  expect(readRunContext('?mode=Profile').mode).toBe('measure');
  expect(readRunContext('?mode=prof').mode).toBe('measure');
  expect(readRunContext('?mode=').mode).toBe('measure');
  expect(readRunContext('?mode=profile').mode).toBe('profile');
});

test('an unrecognized profileState falls back to cold', () => {
  // Cold is what the runner has always done, so it is the safe default to
  // mislabel towards.
  expect(readRunContext('?profileState=hot').profileState).toBe('cold');
  expect(readRunContext('?profileState=warm').profileState).toBe('warm');
});

test('the start gate is opt-in and independent of mode', () => {
  // The two profilers need opposite things: a Chrome CDP trace attaches after
  // load so the page must wait, while Firefox's MOZ_PROFILER_STARTUP records from
  // process start so waiting would only add an idle window to the profile.
  expect(readRunContext('?mode=profile').gate).toBe(false);
  expect(readRunContext('?mode=profile&gate=1').gate).toBe(true);
  expect(readRunContext('?mode=measure&gate=1').gate).toBe(true);
  expect(readRunContext('').gate).toBe(false);
});

test('a gate value other than 1 does not gate', () => {
  // A page that waits when nothing is coming to start it hangs until the runner's
  // timeout, so anything ambiguous must fall through to "do not wait".
  expect(readRunContext('?gate=true').gate).toBe(false);
  expect(readRunContext('?gate=0').gate).toBe(false);
  expect(readRunContext('?gate=').gate).toBe(false);
});

test('a malformed iteration falls back to 1 rather than NaN', () => {
  // NaN would reach the result file and break any aggregation that groups by
  // iteration.
  expect(readRunContext('?iteration=abc').iteration).toBe(1);
  expect(readRunContext('?iteration=0').iteration).toBe(1);
  expect(readRunContext('?iteration=-3').iteration).toBe(1);
  expect(readRunContext('?iteration=7').iteration).toBe(7);
});

// --- refresh-rate calibration cache -----------------------------------------
// A page used to calibrate twice: once for its own `expectedFrames`, then again
// inside `buildResult`. On Firefox those two samples returned 58.75 Hz and 250 Hz
// from the same page, so the envelope advertised a cadence no arm was measured
// against. These pin the single-measurement invariant.

/** Drive rAF at a fixed interval so calibration is deterministic. */
function stubRaf(intervalMs: number): () => void {
  const realRaf = globalThis.requestAnimationFrame;
  const realNow = performance.now;
  let t = 1000;
  // @ts-expect-error test stub
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    t += intervalMs;
    queueMicrotask(() => cb(t));
    return 0;
  };
  // @ts-expect-error test stub
  performance.now = () => t;
  return () => {
    globalThis.requestAnimationFrame = realRaf;
    performance.now = realNow;
  };
}

test('calibration is measured once and reused', async () => {
  resetRefreshRateCache();
  let restore = stubRaf(1000 / 60);
  const first = await calibrateRefreshRate(100);
  restore();
  // Second call under a DIFFERENT cadence must still return the first reading.
  restore = stubRaf(1000 / 240);
  const second = await calibrateRefreshRate(100);
  restore();
  expect(Math.round(first)).toBe(60);
  expect(second).toBe(first);
  resetRefreshRateCache();
});

test('force re-measures rather than reusing the cached cadence', async () => {
  resetRefreshRateCache();
  let restore = stubRaf(1000 / 60);
  const first = await calibrateRefreshRate(100);
  restore();
  restore = stubRaf(1000 / 240);
  const forced = await calibrateRefreshRate(100, true);
  restore();
  expect(Math.round(first)).toBe(60);
  expect(Math.round(forced)).toBe(240);
  resetRefreshRateCache();
});

test('a zero reading is not cached as though it were a measurement', async () => {
  // durationMs <= 0 means "do not calibrate" and returns 0 without awaiting a
  // frame. Caching that would permanently pin every later caller to 0, which
  // validation reports as an invalid environment.
  resetRefreshRateCache();
  expect(await calibrateRefreshRate(0)).toBe(0);
  const restore = stubRaf(1000 / 120);
  const real = await calibrateRefreshRate(100);
  restore();
  expect(Math.round(real)).toBe(120);
  resetRefreshRateCache();
});

// --- cadence estimator ------------------------------------------------------
// `measureRefreshRate` averages the intervals that survive a median-relative
// hitch filter. These pin why neither simpler reduction works: the median is
// wrong for Gecko's 1ms-quantised timestamps, and a plain mean is wrong whenever
// a hitch lands in the sample.

/** Drive rAF from an explicit interval sequence, cycling if it runs short. */
function stubRafSequence(intervalsMs: readonly number[]): () => void {
  const realRaf = globalThis.requestAnimationFrame;
  const realNow = performance.now;
  let t = 1000;
  let i = 0;
  // @ts-expect-error test stub
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    t += intervalsMs[i % intervalsMs.length]!;
    i += 1;
    queueMicrotask(() => cb(t));
    return 0;
  };
  // @ts-expect-error test stub
  performance.now = () => t;
  return () => {
    globalThis.requestAnimationFrame = realRaf;
    performance.now = realNow;
  };
}

test("Gecko's 1ms-quantised dither reads as the panel rate, not the modal delta", async () => {
  // Firefox's rAF timestamp advances in whole milliseconds even under COI, so a
  // 240Hz panel's 4.167ms period is unrepresentable and Gecko dithers 4/5. The
  // measured ratio (2026-08-02, 720 intervals) was 590x4 to 126x5, which is
  // 5 of every 6 — and 5/6*4 + 1/6*5 = 4.167, so the dither IS the period.
  // A median would lock onto the modal 4.00 and report 250Hz.
  const restore = stubRafSequence([4, 4, 4, 4, 4, 5]);
  resetRefreshRateCache();
  const hz = await calibrateRefreshRate(400);
  restore();
  resetRefreshRateCache();
  expect(hz).toBeGreaterThan(238);
  expect(hz).toBeLessThan(242);
});

test('a GC pause does not drag the cadence down', async () => {
  // The reason the median was chosen originally. `expectedFrames` divides by this
  // value, and the starvation check compares achieved frames against it, so an
  // understated cadence understates the expectation and hides real starvation.
  // One 100ms hitch every 40 frames at 240Hz.
  const withHitch = [...Array.from({ length: 39 }, () => 4.167), 100];
  const restore = stubRafSequence(withHitch);
  resetRefreshRateCache();
  const hz = await calibrateRefreshRate(400);
  restore();
  resetRefreshRateCache();
  expect(hz).toBeGreaterThan(238);
  expect(hz).toBeLessThan(242);
});

test('a missed vsync is rejected but the dither is kept', async () => {
  // The filter must distinguish 1.25x the median (Gecko's dither, signal) from
  // 2x (a frame that missed a vsync, not evidence of the display period).
  const restore = stubRafSequence([4, 4, 4, 5, 8.33, 4, 4, 5]);
  resetRefreshRateCache();
  const hz = await calibrateRefreshRate(400);
  restore();
  resetRefreshRateCache();
  // Dither mean is ~4.28ms -> ~233Hz. Including the 8.33 would give ~4.79 -> 209.
  expect(hz).toBeGreaterThan(225);
  expect(hz).toBeLessThan(240);
});

test("Chrome's sub-millisecond intervals are unaffected by the filter", async () => {
  // Chrome has no quantisation, so every interval sits at the true period and
  // all of them must survive: this is the arm that must not regress.
  const restore = stubRafSequence([4.165]);
  resetRefreshRateCache();
  const hz = await calibrateRefreshRate(400);
  restore();
  resetRefreshRateCache();
  expect(hz).toBeCloseTo(240.1, 0);
});

test('a genuinely throttled 60Hz page still reads 60Hz', async () => {
  // An unfocused window loses compositor frame callbacks and rAF falls back to a
  // ~60Hz timer. That is a real cadence for that window, not a hitch, so the
  // filter must not "correct" it towards the panel rate — the starvation check
  // and `validateEnvironment` are what surface the problem.
  const restore = stubRafSequence([16.67]);
  resetRefreshRateCache();
  const hz = await calibrateRefreshRate(400);
  restore();
  resetRefreshRateCache();
  expect(hz).toBeCloseTo(60, 0);
});

/**
 * A scripted cadence sampler plus a clock that only advances when the gate
 * samples.
 *
 * The gate's whole job is a timing decision, and a test that waited on real time
 * would either be slow or flaky. Driving both the samples and the clock makes the
 * deadline exact: the clock advances by the sample duration per probe and by
 * nothing else, so "gave up after N probes" is deterministic.
 */
function scriptedSampler(readings: readonly number[], sampleMs = 200) {
  let index = 0;
  let now = 0;
  return {
    now: () => now,
    calls: () => index,
    sample: (durationMs: number): Promise<number> => {
      now += durationMs;
      // The last reading repeats, which is what a page that never recovers does.
      const value = readings[Math.min(index, readings.length - 1)] ?? 0;
      index += 1;
      return Promise.resolve(value);
    },
    sampleMs,
  };
}

test('the cadence gate returns as soon as the page is at panel rate', async () => {
  // The common case must cost one probe. A gate that always waited a fixed
  // settling time would add that cost to all 26 benchmarks for nothing.
  const s = scriptedSampler([239.9]);
  const outcome = await awaitCadence({
    panelHz: 240,
    sample: s.sample,
    now: s.now,
    sampleMs: s.sampleMs,
  });
  expect(outcome.status).toBe('reached');
  expect(s.calls()).toBe(1);
  expect(outcome.observedHz).toBeCloseTo(239.9, 1);
  expect(outcome.reason).toBeNull();
});

test('the cadence gate waits through a slow start and then proceeds', async () => {
  // The measured defect: a page loads before the runner focuses its window, reads
  // ~60Hz, and only later receives frame callbacks at panel rate. The gate must
  // keep sampling across that transition instead of measuring the 60Hz page.
  const s = scriptedSampler([60.3, 60.1, 60.2, 240.04]);
  const outcome = await awaitCadence({
    panelHz: 240,
    sample: s.sample,
    now: s.now,
    sampleMs: s.sampleMs,
  });
  expect(outcome.status).toBe('reached');
  expect(s.calls()).toBe(4);
  expect(outcome.observedHz).toBeCloseTo(240.04, 1);
  expect(outcome.waitedMs).toBe(800);
});

test('the cadence gate gives up at its deadline instead of hanging', async () => {
  // A gate that could hang would be worse than the defect: the runner's timeout
  // produces no result file at all, whereas proceeding produces one that says why
  // it must not be quoted.
  const s = scriptedSampler([60]);
  const outcome = await awaitCadence({
    panelHz: 240,
    deadlineMs: 1_000,
    sample: s.sample,
    now: s.now,
    sampleMs: s.sampleMs,
  });
  expect(outcome.status).toBe('timeout');
  expect(outcome.waitedMs).toBeGreaterThanOrEqual(1_000);
  // 200ms per probe against a 1s deadline: bounded, not unbounded.
  expect(s.calls()).toBe(5);
  expect(outcome.reason).toContain('60.00Hz');
  expect(outcome.reason).toContain('216.00Hz');
});

test('the cadence gate is skipped when the panel rate is unknown', async () => {
  // Not on Hyprland, or hyprctl unavailable. Waiting for an unknown target could
  // only burn the deadline on every run, so the gate declines to run and says so.
  for (const panelHz of [null, 0, Number.NaN]) {
    const s = scriptedSampler([60]);
    const outcome = await awaitCadence({
      panelHz,
      sample: s.sample,
      now: s.now,
      sampleMs: s.sampleMs,
    });
    expect(outcome.status).toBe('skipped');
    expect(s.calls()).toBe(0);
    expect(outcome.reason).toContain('panel rate unknown');
  }
});

test('the cadence gate does not wait for an over-read it cannot fix', async () => {
  // Sampling above panel rate is an estimator artifact. Waiting could not correct
  // it and would spend the whole deadline; `validateEnvironment` reports it
  // instead.
  const s = scriptedSampler([250]);
  const outcome = await awaitCadence({
    panelHz: 240,
    sample: s.sample,
    now: s.now,
    sampleMs: s.sampleMs,
  });
  expect(outcome.status).toBe('reached');
  expect(s.calls()).toBe(1);
});

test('the cadence gate keeps waiting while no frames arrive at all', async () => {
  // A 0 reading means the page produced no frames in the sample window, which is
  // not evidence that it is throttled — it is evidence it has not started
  // rendering. Treating 0 as a cadence would release the gate immediately.
  const s = scriptedSampler([0, 0, 240]);
  const outcome = await awaitCadence({
    panelHz: 240,
    sample: s.sample,
    now: s.now,
    sampleMs: s.sampleMs,
  });
  expect(outcome.status).toBe('reached');
  expect(s.calls()).toBe(3);
});

test('the cadence gate accepts a 60Hz page on a 60Hz panel', async () => {
  // The gate compares against the panel, not against a hardcoded rate. On a 60Hz
  // display a 60Hz page is correct and must not be made to wait out the deadline.
  const s = scriptedSampler([59.9]);
  const outcome = await awaitCadence({
    panelHz: 60,
    sample: s.sample,
    now: s.now,
    sampleMs: s.sampleMs,
  });
  expect(outcome.status).toBe('reached');
  expect(s.calls()).toBe(1);
});

/**
 * Drive `awaitStart` with a stubbed `/host` and a stubbed rAF, and report whether
 * the cadence gate ran.
 *
 * `awaitStart` reaches the network and the compositor, so both are replaced. The
 * rAF stub reports a throttled 60Hz page against a 240Hz panel, which is the one
 * case where "did the gate run" is unambiguous: if it did, it spends its deadline;
 * if it did not, it returns immediately.
 */
async function runAwaitStart(search: string, deadlineMs: number) {
  const realFetch = globalThis.fetch;
  const realRaf = globalThis.requestAnimationFrame;
  let hostRequests = 0;
  let rafCalls = 0;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    if (String(input).includes('/host')) {
      hostRequests += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ panelHz: 240 }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(new Response('{}'));
  }) as typeof globalThis.fetch;
  // A 60Hz page: every interval is 16.67ms, so the gate can never reach the floor.
  let clock = 0;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    rafCalls += 1;
    clock += 16.67;
    queueMicrotask(() => callback(clock));
    return rafCalls;
  }) as typeof globalThis.requestAnimationFrame;
  resetHostInfoCache();
  resetCadenceGate();
  resetRefreshRateCache();
  const started = Date.now();
  try {
    await awaitStart(
      { ...readRunContext(search), gate: false },
      { cadenceDeadlineMs: deadlineMs, cadenceSampleMs: 50 },
    );
  } finally {
    globalThis.fetch = realFetch;
    globalThis.requestAnimationFrame = realRaf;
    resetHostInfoCache();
    resetCadenceGate();
    resetRefreshRateCache();
  }
  return { hostRequests, elapsedMs: Date.now() - started, deadlineMs };
}

test('awaitStart runs the cadence gate in measure mode', async () => {
  // The gate has to be reached through `awaitStart` for the fix to apply at all:
  // all 26 benchmark entries call `awaitStart`, and none call `awaitCadence`.
  const r = await runAwaitStart('?mode=measure', 300);
  expect(r.hostRequests).toBe(1);
});

test('awaitStart does not run the cadence gate in profile mode', async () => {
  // In profile mode the CDP driver gate already holds the page until the tracer is
  // attached, and an idle wait inside a profile is exactly what that gate exists to
  // avoid recording. A gate here would put its whole wait into every trace.
  const r = await runAwaitStart('?mode=profile', 300);
  expect(r.hostRequests).toBe(0);
});

test('host facts are fetched once and reused', async () => {
  // The gate needs `panelHz` before the run and `buildResult` needs the same facts
  // after it. These are static host properties, so a second request would only add
  // a round trip to every one of the 26 benchmarks.
  const realFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (() => {
    requests += 1;
    return Promise.resolve(
      new Response(JSON.stringify({ panelHz: 240, cpu: 'test' }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof globalThis.fetch;
  resetHostInfoCache();
  try {
    const first = await fetchHostInfo();
    const second = await fetchHostInfo();
    expect(requests).toBe(1);
    expect(second).toEqual(first);
  } finally {
    globalThis.fetch = realFetch;
    resetHostInfoCache();
  }
});

test('a failed host fetch is not cached as a permanent blank', async () => {
  // The page may ask before the server is ready. Caching that null would blank the
  // host block — CPU, GPU, driver, commit — for the whole run, and a result without
  // those is not comparable across machines.
  const realFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (() => {
    requests += 1;
    if (requests === 1) return Promise.reject(new Error('server not up'));
    return Promise.resolve(
      new Response(JSON.stringify({ panelHz: 240 }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof globalThis.fetch;
  resetHostInfoCache();
  try {
    expect(await fetchHostInfo()).toBeNull();
    expect((await fetchHostInfo())?.panelHz).toBe(240);
    expect(requests).toBe(2);
  } finally {
    globalThis.fetch = realFetch;
    resetHostInfoCache();
  }
});
