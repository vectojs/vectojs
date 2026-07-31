/**
 * SVGEntity end-to-end ink gate.
 *
 * `SVGEntity.render()` used to have no `else` after its bitmap/element checks,
 * so any raster failure produced a permanently blank box of *correct size* —
 * indistinguishable from correct output, and invisible to every unit test in
 * this repo (no package runs a real canvas; `packages/ui/test/setup.ts` even
 * stubs `getContext('2d')` with no-ops). This is the same defect class as the
 * inline math that shipped invisible in CTX-0152.
 *
 * The only assertion that can catch it is a real browser counting real pixels,
 * which is what this does, on both engines.
 *
 * Run with `bun run test:e2e` in packages/core. Executable resolution:
 * PUPPETEER_EXECUTABLE_PATH → /usr/bin/chromium → /usr/bin/google-chrome, and
 * FIREFOX_EXECUTABLE_PATH → /usr/bin/firefox.
 */
import puppeteer, { type Browser } from 'puppeteer-core';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { type BrowserCase, bothEngines, closeServer } from './_shared/browsers';
import type { SvgCaseResult, SvgFallbackBrowserResult } from './svg-fallback.fixture';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function isResult(value: unknown): value is SvgFallbackBrowserResult {
  if (typeof value !== 'object' || value === null) return false;
  const cases = (value as { cases?: unknown }).cases;
  if (!Array.isArray(cases)) return false;
  return cases.every((entry: unknown) => {
    const record = entry as Record<string, unknown>;
    return (
      typeof record.name === 'string' &&
      typeof record.width === 'number' &&
      typeof record.height === 'number' &&
      typeof record.hasBitmap === 'boolean' &&
      typeof record.ink === 'number' &&
      typeof record.inkBelow === 'number' &&
      Array.isArray(record.centre) &&
      record.centre.length === 4
    );
  });
}

/**
 * Is this pixel the test artwork's green (`#00c000`) rather than the reddish
 * fallback marker? Tolerant of engine colour-management drift.
 */
function isArtworkGreen(centre: [number, number, number, number]): boolean {
  const [r, g, b, a] = centre;
  return a > 8 && g > 120 && r < 100 && b < 100;
}

function caseByName(result: SvgFallbackBrowserResult, name: string): SvgCaseResult {
  const found = result.cases.find((entry) => entry.name === name);
  if (!found) throw new Error(`Fixture did not report a case named ${name}`);
  return found;
}

async function verifyCase(browserCase: BrowserCase, url: string): Promise<void> {
  const browser: Browser = await puppeteer.launch({
    browser: browserCase.browser,
    executablePath: browserCase.executablePath,
    headless: true,
    args: browserCase.browser === 'chrome' ? ['--no-sandbox'] : [],
    defaultViewport: { width: 640, height: 800, deviceScaleFactor: 1 },
  });

  try {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(url, { waitUntil: 'networkidle0' });
    await page.waitForFunction('window.__ready === true', { timeout: 30_000 });

    const fixtureError: unknown = await page.evaluate(() => window.__svgFallbackError);
    assert.equal(fixtureError, undefined, `${browserCase.name} fixture failed: ${fixtureError}`);

    const result: unknown = await page.evaluate(() => window.__svgFallbackResult);
    assert.ok(isResult(result), `${browserCase.name} returned an invalid result`);

    // Sampling sanity first: if the control strip has ink, the sample region is
    // wrong and every positive count below would be meaningless.
    for (const entry of result.cases) {
      assert.equal(
        entry.inkBelow,
        0,
        `${browserCase.name}/${entry.name}: control strip below the box must be empty, got ${entry.inkBelow}`,
      );
    }

    const valid = caseByName(result, 'valid');
    assert.equal(valid.width, 80, `${browserCase.name}: valid SVG width`);
    assert.equal(valid.height, 60, `${browserCase.name}: valid SVG height`);
    assert.equal(valid.hasBitmap, true, `${browserCase.name}: a valid SVG must rasterize`);
    assert.ok(valid.ink > 0, `${browserCase.name}: a valid SVG must paint pixels`);
    assert.ok(
      isArtworkGreen(valid.centre),
      `${browserCase.name}: valid SVG must paint its own green, got ${valid.centre.join(',')}`,
    );

    const viewboxOnly = caseByName(result, 'viewboxOnly');
    assert.equal(viewboxOnly.width, 40, `${browserCase.name}: viewBox-derived width`);
    assert.ok(viewboxOnly.ink > 0, `${browserCase.name}: a viewBox-only SVG must paint pixels`);

    // The repair, not merely a nicer failure: markup without `xmlns` is
    // well-formed XML with correct dimensions that the image DECODER rejects.
    // Declaring the namespace must make it rasterize the real artwork, so it
    // has a bitmap and the same ink as the identical namespaced source.
    const missingXmlns = caseByName(result, 'missingXmlns');
    assert.equal(missingXmlns.width, 80, `${browserCase.name}: no-xmlns width still parses`);
    assert.ok(
      missingXmlns.ink > 0,
      `${browserCase.name}: an SVG without xmlns must not be a blank box`,
    );
    assert.equal(
      missingXmlns.hasBitmap,
      true,
      `${browserCase.name}: an SVG without xmlns must be REPAIRED into a real raster, not fall back`,
    );
    assert.equal(
      missingXmlns.ink,
      valid.ink,
      `${browserCase.name}: repaired no-xmlns artwork must match the namespaced source pixel for pixel`,
    );
    // Ink COUNT alone cannot prove this: a solid-fill rect and a full-box
    // fallback fill cover identical pixels. Firefox really did report
    // `ink === valid.ink` while drawing the fallback, so assert the colour.
    assert.ok(
      isArtworkGreen(missingXmlns.centre),
      `${browserCase.name}: repaired no-xmlns box must contain the artwork's green, not the fallback marker; got ${missingXmlns.centre.join(',')}`,
    );

    // Genuinely undecodable input keeps its reserved box but must be visibly
    // marked, never silently blank.
    const malformed = caseByName(result, 'malformed');
    assert.equal(malformed.hasBitmap, false, `${browserCase.name}: malformed SVG cannot rasterize`);
    assert.ok(
      malformed.ink > 0,
      `${browserCase.name}: malformed SVG must draw a visible fallback, not a blank box`,
    );
    assert.equal(
      isArtworkGreen(malformed.centre),
      false,
      `${browserCase.name}: malformed SVG cannot show artwork; got ${malformed.centre.join(',')}`,
    );
    assert.ok(
      malformed.centre[3] > 8,
      `${browserCase.name}: malformed SVG's centre pixel must be opaque (the fallback marker), got alpha ${malformed.centre[3]}`,
    );

    // The fixture deliberately feeds in malformed markup, and Firefox surfaces
    // the resulting XML parse failure as a page-level error. Only errors that
    // are NOT that expected parse failure indicate a real problem.
    const unexpectedErrors = pageErrors.filter(
      (message) => !/not well-formed|XML Parsing Error|error on line/i.test(message),
    );
    assert.deepEqual(
      unexpectedErrors,
      [],
      `${browserCase.name} raised unexpected page errors: ${unexpectedErrors.join(' | ')}`,
    );
    console.log(
      `  ✓ ${browserCase.name}: valid ${valid.ink} ink, repaired-no-xmlns ${missingXmlns.ink} ink (bitmap ${missingXmlns.hasBitmap}), malformed fallback ${malformed.ink} ink`,
    );
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const fixture = await build({
    entryPoints: [join(packageRoot, 'e2e/svg-fallback.fixture.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });

  const entrySource = fixture.outputFiles[0]?.text;
  if (!entrySource) throw new Error('Failed to bundle the svg-fallback fixture');

  const markup =
    '<!doctype html><html><body style="margin:0"><script type="module" src="/fixture.mjs"></script></body></html>';
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/' || pathname === '/index.html') {
      response.setHeader('content-type', 'text/html');
      response.end(markup);
      return;
    }
    if (pathname === '/fixture.mjs') {
      response.setHeader('content-type', 'text/javascript');
      response.end(entrySource);
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server has no TCP port');
  const url = `http://127.0.0.1:${address.port}/`;

  const cases: BrowserCase[] = bothEngines();

  try {
    for (const browserCase of cases) await verifyCase(browserCase, url);
    console.log('\nSVGEntity fallback e2e: all checks passed on both engines');
  } finally {
    await closeServer(server);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
