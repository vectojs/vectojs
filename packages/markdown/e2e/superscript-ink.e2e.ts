import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer, { type Browser } from 'puppeteer-core';
import { type BrowserCase, bothEngines, closeServer } from '../../core/e2e/_shared/browsers';

/**
 * `^th^` must paint smaller and higher than the same letters at uniform size,
 * not merely carry the right span style.
 *
 * The unit suite (`test/superscript.test.ts`) asserts span styles, which stops
 * one step short of the canvas: `RichText`'s draw path is untested in jsdom
 * (no 2D context). This closes that gap: the ink in `^th^` (mixed) must end
 * STRICTLY higher (smaller `bottomInkRow`) than the same letters at uniform
 * size (`th`, plain).
 *
 * Isolated to just the raised run rather than a sentence like `19^th^ place`:
 * a first attempt measured the whole paragraph and the dominant, unshifted `19`
 * and ` place` glyphs (both taller than the shrunk `th`) set the box's topInkRow
 * regardless of whether `th` was shifted, so the gate never actually exercised
 * the signal it claimed to.
 *
 * The gate reads `bottomInkRow`, not `topInkRow`. Worked out from
 * `LayoutEngine`'s own glyph placement (`y = (pMax - gfs) * 0.8 - shift`) at
 * the theme's exact defaults (`superscriptScale: 0.75`, `superscriptShift:
 * 0.2`, `fontSize: 48`) for an isolated lone run: `pMax` stays at the base
 * `fontSize` (no line growth — the shift sits exactly on `shiftedExtent`'s
 * no-growth boundary at these numbers), and the shift term (`0.2 * 48 = 9.6`)
 * exactly cancels the shrink term (`(48 - 36) * 0.8 = 9.6`), so `mixed.y` and
 * `plain.y` coincide and `topInkRow` is identical in both cases — a genuine
 * coincidence of these particular defaults, not a defect. The BOTTOM still
 * differs because the mixed run is shorter (`height = 36` vs `48`), and that
 * shortening is dominated by the shift rather than the scale: an unshifted run
 * merely shrunk to 0.75x would end only ~2.4px higher (`(1 - 0.75) * 0.2 *
 * fontSize`), while the shift itself moves the whole box up by `0.2 * fontSize
 * = 9.6px` — four times as much. So a clear `bottomInkRow` gap is still good
 * evidence the shift reached the canvas, even though this particular gate does
 * not cleanly separate "smaller" from "higher".
 */

interface RaisedInkCase {
  topInkRow: number;
  bottomInkRow: number;
  totalInk: number;
  text: string;
}

interface SuperscriptInkResult {
  mixed: RaisedInkCase;
  plain: RaisedInkCase;
}

function isCase(value: unknown): value is RaisedInkCase {
  return (
    typeof value === 'object' &&
    value !== null &&
    'topInkRow' in value &&
    typeof value.topInkRow === 'number' &&
    'bottomInkRow' in value &&
    typeof value.bottomInkRow === 'number' &&
    'totalInk' in value &&
    typeof value.totalInk === 'number' &&
    'text' in value &&
    typeof value.text === 'string'
  );
}

function isSuperscriptInkResult(value: unknown): value is SuperscriptInkResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'mixed' in value &&
    isCase(value.mixed) &&
    'plain' in value &&
    isCase(value.plain)
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

    const result: unknown = await page.evaluate(() => Reflect.get(window, '__supInk'));
    assert.ok(isSuperscriptInkResult(result), `${browserCase.name} returned invalid ink data`);
    const { mixed, plain } = result;

    // The projected text: `^th^` prints as `th`, no carets.
    assert.equal(mixed.text, 'th', `${browserCase.name} mixed text`);
    assert.equal(plain.text, 'th', `${browserCase.name} plain text`);

    // Both drew something, or the row comparison below is meaningless. Lower
    // than the tildeInk gate's threshold: `th` alone is two characters at a
    // scale as low as 0.75x, not an eleven-character sentence at full size.
    assert.ok(mixed.totalInk > 100, `${browserCase.name} mixed drew ${mixed.totalInk} px`);
    assert.ok(plain.totalInk > 100, `${browserCase.name} plain drew ${plain.totalInk} px`);

    // THE GATE. See the module doc for the exact arithmetic: at these theme
    // defaults `topInkRow` coincides for a lone raised run (a real coincidence
    // of these numbers, not evidence of nothing happening), but `bottomInkRow`
    // does not — the shrunk, raised run's box ends well above the full-size
    // run's, because the shift (not merely the 0.75x shrink) pulls the whole
    // box upward. An unshifted run would have an equal or larger bottomInkRow.
    //
    // A bare `<` was too weak: sabotaging the fix by dropping `baselineShift`
    // and keeping only the `fontSize` shrink still passed (mixed=37 vs
    // plain=38 — a smaller glyph alone ends one row higher even with no
    // shift, from antialiasing/hinting, not from being raised). The correct
    // implementation's margin is the theme shift itself, `runSize *
    // superscriptShift` = `48 * 0.2` = 9.6px; this requires at least half
    // that (a shift-sized effect, not a shrink-sized one) before calling it
    // "raised".
    const minMargin = 48 * 0.2 * 0.5; // half the theme's shift-in-px at fontSize 48
    assert.ok(
      plain.bottomInkRow - mixed.bottomInkRow > minMargin,
      `${browserCase.name} superscript did not raise ink enough: mixed.bottom=${mixed.bottomInkRow} plain.bottom=${plain.bottomInkRow} (margin ${plain.bottomInkRow - mixed.bottomInkRow}, need > ${minMargin})`,
    );

    assert.deepEqual(pageErrors, []);
    console.log(
      `✓ ${browserCase.name}: bottomInkRow mixed=${mixed.bottomInkRow} plain=${plain.bottomInkRow}`,
    );
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const fixture = await build({
    entryPoints: [join(packageRoot, 'e2e/superscript-ink.fixture.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  const fixtureSource = fixture.outputFiles[0]?.text;
  if (!fixtureSource) throw new Error('Failed to bundle the superscript browser fixture');

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
