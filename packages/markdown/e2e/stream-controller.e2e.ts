import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer, { type Browser } from 'puppeteer-core';
import { type BrowserCase, bothEngines, closeServer } from '../../core/e2e/_shared/browsers';
import type { StreamControllerBrowserResult } from './stream-controller.fixture';

function isStreamControllerResult(value: unknown): value is StreamControllerBrowserResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'burstAppends' in value &&
    typeof value.burstAppends === 'number' &&
    'burstSourceLength' in value &&
    typeof value.burstSourceLength === 'number' &&
    'ordered' in value &&
    typeof value.ordered === 'boolean' &&
    'pacedClusterIntact' in value &&
    typeof value.pacedClusterIntact === 'boolean' &&
    'finalFlushed' in value &&
    typeof value.finalFlushed === 'boolean' &&
    'aborted' in value &&
    typeof value.aborted === 'boolean' &&
    'destroyed' in value &&
    typeof value.destroyed === 'boolean'
  );
}

async function verifyCase(browserCase: BrowserCase, url: string): Promise<void> {
  const browser: Browser = await puppeteer.launch({
    browser: browserCase.browser,
    executablePath: browserCase.executablePath,
    headless: true,
    args: browserCase.browser === 'chrome' ? ['--no-sandbox'] : [],
    defaultViewport: { width: 320, height: 240, deviceScaleFactor: 1 },
  });

  try {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(url, { waitUntil: 'networkidle0' });
    await page.waitForFunction('window.__ready === true', { timeout: 10_000 });
    const result: unknown = await page.evaluate(() => window.__streamControllerResult);
    const fixtureError: unknown = await page.evaluate(() => window.__streamControllerError);

    assert.equal(fixtureError, undefined, `${browserCase.name} fixture failed: ${fixtureError}`);
    assert.ok(isStreamControllerResult(result), `${browserCase.name} returned an invalid result`);
    assert.deepEqual(result, {
      burstAppends: 1,
      burstSourceLength: 100,
      ordered: true,
      pacedClusterIntact: true,
      finalFlushed: true,
      aborted: true,
      destroyed: true,
    });
    assert.deepEqual(pageErrors, []);
    console.log(`✓ ${browserCase.name}: ${JSON.stringify(result)}`);
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const fixture = await build({
    entryPoints: [join(packageRoot, 'e2e/stream-controller.fixture.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  const fixtureSource = fixture.outputFiles[0]?.text;
  if (!fixtureSource) throw new Error('Failed to bundle StreamController browser fixture');

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
