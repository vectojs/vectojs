import { expect, test } from 'bun:test';
import {
  browserVersionFromUa,
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
