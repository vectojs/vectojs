import { expect, test } from 'bun:test';
import {
  browserVersionFromUa,
  CADENCE_OVER_TOLERANCE,
  CADENCE_TOLERANCE,
  engineFromUa,
  SCHEMA_VERSION,
  validateEnvironment,
  type ViewportInfo,
} from './schema.ts';

const viewport = (width: number, height: number, dpr: number): ViewportInfo => ({
  width,
  height,
  dpr,
  rasterPixels: width * height * dpr * dpr,
});

const CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const FIREFOX_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0';
const CHROMIUM_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chromium/149.0.0.0 Safari/537.36';

test('schema version is exported and positive', () => {
  expect(SCHEMA_VERSION).toBeGreaterThan(0);
});

test('engine is read from the UA for both driven browsers', () => {
  expect(engineFromUa(CHROME_UA)).toBe('chrome');
  expect(engineFromUa(FIREFOX_UA)).toBe('firefox');
  expect(engineFromUa(CHROMIUM_UA)).toBe('chrome');
  expect(engineFromUa('Mozilla/5.0 (curl)')).toBe('unknown');
});

test('firefox is not mislabelled as chrome by the Safari token', () => {
  // Chrome's UA contains "Safari" and Firefox's contains neither "Chrome" nor
  // "Chromium", so an order-of-tests mistake here silently labels every Firefox
  // run as chrome and the two engines' numbers get averaged together.
  expect(engineFromUa(FIREFOX_UA)).not.toBe('chrome');
});

test('browser version is parsed for both engines', () => {
  expect(browserVersionFromUa(CHROME_UA)).toBe('150.0.0.0');
  expect(browserVersionFromUa(FIREFOX_UA)).toBe('145.0');
  expect(browserVersionFromUa(CHROMIUM_UA)).toBe('149.0.0.0');
});

test('browser version is null rather than a guess when unrecognized', () => {
  expect(browserVersionFromUa('Mozilla/5.0 (curl)')).toBeNull();
});

test('a clean environment validates with an empty issue list', () => {
  const v = validateEnvironment({
    refreshHz: 240.1,
    crossOriginIsolated: true,
    viewport: viewport(900, 700, 2),
  });
  expect(v.ok).toBe(true);
  // Present and empty, not omitted: "validated clean" must be distinguishable
  // from "never validated".
  expect(v.issues).toEqual([]);
});

test('a zero refresh rate is a validation failure', () => {
  const v = validateEnvironment({
    refreshHz: 0,
    crossOriginIsolated: true,
    viewport: viewport(900, 700, 2),
  });
  expect(v.ok).toBe(false);
  expect(v.issues.join(' ')).toContain('refreshHz is 0');
});

test('losing cross-origin isolation is a validation failure', () => {
  // Without it performance.now() coarsens to ~100us, which is the same order as
  // the per-frame costs these benchmarks resolve.
  const v = validateEnvironment({
    refreshHz: 240,
    crossOriginIsolated: false,
    viewport: viewport(900, 700, 2),
  });
  expect(v.ok).toBe(false);
  expect(v.issues.join(' ')).toContain('cross-origin isolated');
});

test('a stale rasterPixels count is caught', () => {
  const v = validateEnvironment({
    refreshHz: 240,
    crossOriginIsolated: true,
    viewport: { width: 900, height: 700, dpr: 2, rasterPixels: 900 * 700 },
  });
  expect(v.ok).toBe(false);
  expect(v.issues.join(' ')).toContain('rasterPixels');
});

test('multiple problems are all reported, not just the first', () => {
  const v = validateEnvironment({
    refreshHz: 0,
    crossOriginIsolated: false,
    viewport: viewport(900, 700, 1),
  });
  expect(v.issues.length).toBe(2);
});

test('raster pixel count scales with the square of DPR', () => {
  // The reason DPR is in the envelope at all: same CSS size, 4x the pixels.
  expect(viewport(900, 700, 2).rasterPixels).toBe(4 * viewport(900, 700, 1).rasterPixels);
});

test('a cadence far below the panel rate is a validation failure', () => {
  // The defect this exists for. Measured 2026-08-03: the same command at the same
  // commit produced Firefox rows at 239.68Hz and at 60.30Hz, and the 60Hz rows
  // were not merely thinner — per-flush cost was worse and more variable. Such a
  // row must be discarded, so the file has to say so itself.
  const v = validateEnvironment({
    refreshHz: 60.3,
    crossOriginIsolated: true,
    viewport: viewport(900, 700, 2),
    panelHz: 240,
  });
  expect(v.ok).toBe(false);
  expect(v.issues.join(' ')).toContain('far below');
  expect(v.issues.join(' ')).toContain('must not be quoted');
});

test('a cadence above the panel rate is reported as a broken estimate, not starvation', () => {
  // No display delivers more frames than its rate, so an over-read means the
  // estimator is wrong — which also invalidates the expected-frame count the
  // starvation check divides by. Taking the median of Gecko's 4/5ms dither did
  // exactly this: 250Hz on a 240Hz panel (fixed in #327).
  const v = validateEnvironment({
    refreshHz: 250,
    crossOriginIsolated: true,
    viewport: viewport(900, 700, 2),
    panelHz: 240,
  });
  expect(v.ok).toBe(false);
  expect(v.issues.join(' ')).toContain('exceeds');
  expect(v.issues.join(' ')).not.toContain('far below');
});

test('a cadence within tolerance of the panel rate passes', () => {
  // Gecko's whole-millisecond dither averages to 239.94Hz on a 240Hz panel, and
  // Chrome reads 240.1. Neither is a defect, so neither may be flagged. 232 is
  // just inside the wide low-side bound; 241 is just inside the tight high one.
  for (const refreshHz of [239.94, 240.1, 240, 232, 241]) {
    const v = validateEnvironment({
      refreshHz,
      crossOriginIsolated: true,
      viewport: viewport(900, 700, 2),
      panelHz: 240,
    });
    expect(v.ok).toBe(true);
  }
});

test('an unknown panel rate disables the cadence check rather than guessing', () => {
  // A fabricated expectation would flag every run on a host whose compositor this
  // does not know how to interrogate.
  for (const panelHz of [null, undefined, 0]) {
    const v = validateEnvironment({
      refreshHz: 60,
      crossOriginIsolated: true,
      viewport: viewport(900, 700, 2),
      panelHz,
    });
    expect(v.ok).toBe(true);
  }
});

test('a zero cadence is reported once, not also as a panel mismatch', () => {
  // `refreshHz === 0` has its own, more specific issue: no frames arrived at all.
  // Reporting it a second time as "far below the panel" adds noise, not signal.
  const v = validateEnvironment({
    refreshHz: 0,
    crossOriginIsolated: true,
    viewport: viewport(900, 700, 2),
    panelHz: 240,
  });
  expect(v.issues.length).toBe(1);
  expect(v.issues[0]).toContain('no animation frames');
});

test('the two cadence tolerances each bracket the failure they exist to catch', () => {
  // Neither is a magic number, and one value cannot do both jobs — which is the
  // point of having two. Both must clear Gecko's 0.025% dither error. The low side
  // must then stay under the 75% focus cliff, while the high side must stay under
  // the 4.2% median artifact (#327) that a single 10% bound would have admitted.
  expect(CADENCE_TOLERANCE).toBeGreaterThan(0.025 / 100);
  expect(CADENCE_TOLERANCE).toBeLessThan(0.75);
  expect(CADENCE_OVER_TOLERANCE).toBeGreaterThan(0.025 / 100);
  expect(CADENCE_OVER_TOLERANCE).toBeLessThan(0.042);
});
