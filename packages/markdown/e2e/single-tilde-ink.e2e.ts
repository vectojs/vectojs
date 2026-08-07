import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer, { type Browser } from 'puppeteer-core';
import { type BrowserCase, bothEngines, closeServer } from '../../core/e2e/_shared/browsers';

/**
 * `H~2~O` must not paint a strike line; `H~~2~~O` must.
 *
 * The unit suite (`test/singleTilde.test.ts`) asserts span styles, which stops one
 * step short of the defect a reader experienced. This closes that gap with real
 * pixels in both engines: the struck case must carry more ink in a band across the
 * middle of the run than the unstruck case.
 *
 * Why a threshold rather than an exact figure: the rule's length and thickness come
 * from the resolved font, and the two engines substitute differently on a bare CI
 * runner, so an exact count would pin a metric neither engine guarantees.
 *
 * ## Sabotage-verified
 *
 * Dropping `lineThrough` from the strikethrough recursion in `markdown-inline.ts`
 * (text unchanged, so the text assertions still pass and this gate is the one that
 * speaks) failed with `strikethrough drew no rule: maxRunFraction 0.104` — exactly
 * the plain-prose value, in both engines. Restored, both report 0.510 again.
 */

interface TildeInkCase {
  maxRunFraction: number;
  totalInk: number;
  text: string;
}

interface TildeInkResult {
  single: TildeInkCase;
  double: TildeInkCase;
  plain: TildeInkCase;
}

function isCase(value: unknown): value is TildeInkCase {
  return (
    typeof value === 'object' &&
    value !== null &&
    'maxRunFraction' in value &&
    typeof value.maxRunFraction === 'number' &&
    'totalInk' in value &&
    typeof value.totalInk === 'number' &&
    'text' in value &&
    typeof value.text === 'string'
  );
}

function isTildeInkResult(value: unknown): value is TildeInkResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'single' in value &&
    isCase(value.single) &&
    'double' in value &&
    isCase(value.double) &&
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

    const result: unknown = await page.evaluate(() => Reflect.get(window, '__tildeInk'));
    assert.ok(isTildeInkResult(result), `${browserCase.name} returned invalid ink data`);
    const { single, double, plain } = result;

    // The projected text, which is what a screen reader and a copy both yield.
    assert.equal(single.text, '~Hello world~', `${browserCase.name} single-tilde text`);
    assert.equal(double.text, 'Hello world', `${browserCase.name} double-tilde text`);
    assert.equal(plain.text, 'Hello world', `${browserCase.name} plain text`);

    // All three drew something. Without this the shape comparisons below would be
    // satisfied by a blank canvas in the unstruck cases.
    for (const [name, value] of [
      ['single', single],
      ['double', double],
      ['plain', plain],
    ] as const) {
      assert.ok(value.totalInk > 500, `${browserCase.name} ${name} drew ${value.totalInk} px`);
    }

    // THE GATE. Measured identically in both engines: 0.510 struck, 0.083
    // single-tilde, 0.104 plain — a 5x separation, so 0.35/0.20 leaves wide room
    // for a different font substitution while still being decisive.
    assert.ok(
      double.maxRunFraction > 0.35,
      `${browserCase.name} strikethrough drew no rule: maxRunFraction ${double.maxRunFraction}`,
    );
    assert.ok(
      single.maxRunFraction < 0.2,
      `${browserCase.name} single-tilde drew a rule it should not have: maxRunFraction ${single.maxRunFraction}`,
    );
    // The floor for "no rule", from a case with no tilde syntax at all. Ties the
    // single-tilde number to prose rather than to a bare constant.
    assert.ok(
      plain.maxRunFraction < 0.2,
      `${browserCase.name} plain prose drew a rule: maxRunFraction ${plain.maxRunFraction}`,
    );

    assert.deepEqual(pageErrors, []);
    console.log(
      `✓ ${browserCase.name}: maxRunFraction struck=${double.maxRunFraction.toFixed(3)} single-tilde=${single.maxRunFraction.toFixed(3)} plain=${plain.maxRunFraction.toFixed(3)}`,
    );
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const fixture = await build({
    entryPoints: [join(packageRoot, 'e2e/single-tilde-ink.fixture.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  const fixtureSource = fixture.outputFiles[0]?.text;
  if (!fixtureSource) throw new Error('Failed to bundle the single-tilde browser fixture');

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
