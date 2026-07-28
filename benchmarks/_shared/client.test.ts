import { expect, test } from 'bun:test';
import { calibrateRefreshRate, readRunContext, resetRefreshRateCache } from './client.ts';

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
