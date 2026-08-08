import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer, { type Browser } from 'puppeteer-core';
import { type BrowserCase, bothEngines, closeServer } from '../../core/e2e/_shared/browsers';

/**
 * `++inserted++` must draw an underline and `==marked==` must draw a
 * background fill, not merely carry the right span style.
 *
 * The unit suite (`test/insMark.test.ts`) asserts span styles, which stops one
 * step short of the canvas: `RichText`'s draw path is untested in jsdom (no 2D
 * context). This closes that gap for both constructs — see the module doc in
 * `ins-mark-ink.fixture.ts` for exactly what each case measures and why.
 */

interface InsCase {
  bottomInkRow: number;
  totalInk: number;
  text: string;
}

interface MarkCase {
  cornerColor: [number, number, number, number];
  text: string;
}

interface InsMarkInkResult {
  insMixed: InsCase;
  insPlain: InsCase;
  mark: MarkCase;
  markPlain: MarkCase;
}

function isInsCase(value: unknown): value is InsCase {
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

function isMarkCase(value: unknown): value is MarkCase {
  return (
    typeof value === 'object' &&
    value !== null &&
    'cornerColor' in value &&
    Array.isArray((value as { cornerColor: unknown }).cornerColor) &&
    'text' in value &&
    typeof value.text === 'string'
  );
}

function isInsMarkInkResult(value: unknown): value is InsMarkInkResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'insMixed' in value &&
    isInsCase(value.insMixed) &&
    'insPlain' in value &&
    isInsCase(value.insPlain) &&
    'mark' in value &&
    isMarkCase(value.mark) &&
    'markPlain' in value &&
    isMarkCase(value.markPlain)
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

    const result: unknown = await page.evaluate(() => Reflect.get(window, '__insMarkInk'));
    assert.ok(isInsMarkInkResult(result), `${browserCase.name} returned invalid ink data`);
    const { insMixed, insPlain, mark, markPlain } = result;

    // Projected text: no delimiters in either case.
    assert.equal(insMixed.text, 'line', `${browserCase.name} ins mixed text`);
    assert.equal(insPlain.text, 'line', `${browserCase.name} ins plain text`);
    assert.equal(mark.text, 'word', `${browserCase.name} mark text`);
    assert.equal(markPlain.text, 'word', `${browserCase.name} mark-plain text`);

    // Both drew something, or the row comparison below is meaningless.
    assert.ok(
      insMixed.totalInk > 100,
      `${browserCase.name} ins mixed drew ${insMixed.totalInk} px`,
    );
    assert.ok(
      insPlain.totalInk > 100,
      `${browserCase.name} ins plain drew ${insPlain.totalInk} px`,
    );

    // INS GATE: the underline stroke sits 2px below the baseline, well past
    // any glyph's descender for "line" (no descenders at all, in fact), so the
    // underlined case's inked region must extend further down than the plain
    // control's — not a bare `<`, for the same reason `superscript-ink.e2e.ts`
    // requires a margin (a bare inequality passed for a weakened impl that
    // barely moved the metric). Measured at these exact defaults (48px font,
    // 2px offset, hairline `Math.max(1, size/14)` stroke width): margin is 3
    // rows in Chromium, so the threshold sits below that with room for
    // antialiasing variance across engines while still rejecting "moved by 1".
    const margin = insMixed.bottomInkRow - insPlain.bottomInkRow;
    assert.ok(
      margin > 1,
      `${browserCase.name} ins did not extend ink far enough below plain text: ` +
        `mixed.bottom=${insMixed.bottomInkRow} plain.bottom=${insPlain.bottomInkRow} margin=${margin}`,
    );

    // MARK GATE: the corner pixel (inside the run's glyph box, above any
    // glyph's ink) is fully transparent for the plain control (the canvas
    // starts transparent and nothing else paints there) and NOT for the
    // marked run — `highlightRun`'s fill is the only thing that can put any
    // alpha at that spot at all.
    assert.equal(
      markPlain.cornerColor[3],
      0,
      `${browserCase.name} plain corner was not transparent: ${JSON.stringify(markPlain.cornerColor)}`,
    );
    assert.ok(
      mark.cornerColor[3] > 0,
      `${browserCase.name} mark corner has no ink — the highlight fill did not reach the canvas: ${JSON.stringify(mark.cornerColor)}`,
    );

    assert.deepEqual(pageErrors, []);
    console.log(
      `✓ ${browserCase.name}: ins bottomInkRow mixed=${insMixed.bottomInkRow} plain=${insPlain.bottomInkRow}; ` +
        `mark corner=${JSON.stringify(mark.cornerColor)} plainCorner=${JSON.stringify(markPlain.cornerColor)}`,
    );
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const fixture = await build({
    entryPoints: [join(packageRoot, 'e2e/ins-mark-ink.fixture.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  const fixtureSource = fixture.outputFiles[0]?.text;
  if (!fixtureSource) throw new Error('Failed to bundle the ins/mark browser fixture');

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
