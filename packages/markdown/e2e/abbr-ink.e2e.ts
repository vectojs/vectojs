import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer, { type Browser } from 'puppeteer-core';
import { type BrowserCase, bothEngines, closeServer } from '../../core/e2e/_shared/browsers';

/**
 * A recognised abbreviation must draw a dotted underline, not merely carry
 * `abbrTitle` on its span style.
 *
 * The unit suite (`test/abbr.test.ts`) asserts the span style, which stops
 * one step short of the canvas: `RichText`'s draw path is untested in jsdom
 * (no 2D context). This closes that gap — see the module doc in
 * `abbr-ink.fixture.ts` for exactly what is measured and why.
 */

interface AbbrCase {
  bottomInkRow: number;
  totalInk: number;
  text: string;
}

interface AbbrInkResult {
  abbreviated: AbbrCase;
  plain: AbbrCase;
}

function isAbbrCase(value: unknown): value is AbbrCase {
  return (
    typeof value === 'object' &&
    value !== null &&
    'bottomInkRow' in value &&
    typeof value.bottomInkRow === 'number' &&
    'totalInk' in value &&
    typeof value.totalInk === 'number' &&
    'text' in value &&
    typeof value.text === 'string'
  );
}

function isAbbrInkResult(value: unknown): value is AbbrInkResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'abbreviated' in value &&
    isAbbrCase(value.abbreviated) &&
    'plain' in value &&
    isAbbrCase(value.plain)
  );
}

async function verifyCase(browserCase: BrowserCase, url: string): Promise<void> {
  const browser: Browser = await puppeteer.launch({
    browser: browserCase.browser,
    executablePath: browserCase.executablePath,
    headless: true,
    args: browserCase.browser === 'chrome' ? ['--no-sandbox'] : [],
    defaultViewport: { width: 360, height: 320, deviceScaleFactor: 1 },
  });

  try {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(url, { waitUntil: 'networkidle0' });
    await page.waitForFunction('window.__ready === true', { timeout: 10_000 });

    const result: unknown = await page.evaluate(() => Reflect.get(window, '__abbrInk'));
    assert.ok(isAbbrInkResult(result), `${browserCase.name} returned invalid ink data`);
    const { abbreviated, plain } = result;

    // Projected text: no definition line leaks into the paragraph, and the
    // dictionary does not swallow the word itself.
    assert.equal(abbreviated.text, 'line', `${browserCase.name} abbreviated text`);
    assert.equal(plain.text, 'line', `${browserCase.name} plain text`);

    // Both drew something, or the row comparison below is meaningless.
    assert.ok(
      abbreviated.totalInk > 100,
      `${browserCase.name} abbreviated drew ${abbreviated.totalInk} px`,
    );
    assert.ok(plain.totalInk > 100, `${browserCase.name} plain drew ${plain.totalInk} px`);

    // GATE: the dot row sits 3px below the baseline, well past any glyph's
    // descender for "line" (no descenders at all), so the abbreviated case's
    // inked region must extend further down than the plain control's — not a
    // bare `<`, for the same reason `ins-mark-ink.e2e.ts` requires a margin (a
    // bare inequality passed for a weakened impl that barely moved the
    // metric).
    const margin = abbreviated.bottomInkRow - plain.bottomInkRow;
    assert.ok(
      margin > 1,
      `${browserCase.name} abbreviation did not extend ink far enough below plain text: ` +
        `abbreviated.bottom=${abbreviated.bottomInkRow} plain.bottom=${plain.bottomInkRow} margin=${margin}`,
    );

    assert.deepEqual(pageErrors, []);
    console.log(
      `✓ ${browserCase.name}: abbr bottomInkRow abbreviated=${abbreviated.bottomInkRow} plain=${plain.bottomInkRow}`,
    );
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const fixture = await build({
    entryPoints: [join(packageRoot, 'e2e/abbr-ink.fixture.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  const fixtureSource = fixture.outputFiles[0]?.text;
  if (!fixtureSource) throw new Error('Failed to bundle the abbreviation browser fixture');

  const markup =
    '<!doctype html><html><body><script type="module" src="/fixture.mjs"></script></body></html>';
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/' || pathname === '/index.html') {
      response.setHeader('content-type', 'text/html');
      response.end(markup);
      return;
    }
    if (pathname === '/fixture.mjs') {
      response.setHeader('content-type', 'text/javascript');
      response.end(fixtureSource);
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
  } finally {
    await closeServer(server);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
