import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer, { type Browser } from 'puppeteer-core';

interface BlockquoteLayoutResult {
  outerWidth: number;
  outerWrapperRight: number;
  nestedWidth: number;
  nestedWrapperRight: number;
  paragraphMaxWidth: number;
}

interface BrowserCase {
  name: string;
  browser: 'chrome' | 'firefox';
  executablePath: string;
}

function isBlockquoteLayoutResult(value: unknown): value is BlockquoteLayoutResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'outerWidth' in value &&
    typeof value.outerWidth === 'number' &&
    'outerWrapperRight' in value &&
    typeof value.outerWrapperRight === 'number' &&
    'nestedWidth' in value &&
    typeof value.nestedWidth === 'number' &&
    'nestedWrapperRight' in value &&
    typeof value.nestedWrapperRight === 'number' &&
    'paragraphMaxWidth' in value &&
    typeof value.paragraphMaxWidth === 'number'
  );
}

function executable(candidates: string[], label: string): string {
  const path = candidates.find((candidate) => candidate.length > 0 && existsSync(candidate));
  if (!path) throw new Error(`No ${label} executable found (${candidates.join(', ')})`);
  return path;
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

    const result: unknown = await page.evaluate(() => Reflect.get(window, '__blockquoteLayout'));
    assert.ok(isBlockquoteLayoutResult(result), `${browserCase.name} returned invalid geometry`);
    assert.equal(result.outerWidth, 120);
    assert.ok(
      result.outerWrapperRight <= result.outerWidth,
      `${browserCase.name} outer wrapper ends at ${result.outerWrapperRight}, past ${result.outerWidth}`,
    );
    assert.equal(result.nestedWidth, 104);
    assert.ok(
      result.nestedWrapperRight <= result.nestedWidth,
      `${browserCase.name} nested wrapper ends at ${result.nestedWrapperRight}, past ${result.nestedWidth}`,
    );
    assert.equal(result.paragraphMaxWidth, 88);
    assert.deepEqual(pageErrors, []);
    console.log(`✓ ${browserCase.name}: ${JSON.stringify(result)}`);
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const fixture = await build({
    entryPoints: [join(packageRoot, 'e2e/blockquote-layout.fixture.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  const fixtureSource = fixture.outputFiles[0]?.text;
  if (!fixtureSource) throw new Error('Failed to bundle the blockquote browser fixture');

  const markup =
    '<!doctype html><html><body><canvas width="320" height="240"></canvas><script type="module" src="/fixture.mjs"></script></body></html>';
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

  const cases: BrowserCase[] = [
    {
      name: 'chromium',
      browser: 'chrome',
      executablePath: executable(
        [
          process.env.PUPPETEER_EXECUTABLE_PATH ?? '',
          '/usr/bin/chromium',
          '/usr/bin/google-chrome',
        ],
        'Chromium',
      ),
    },
    {
      name: 'firefox',
      browser: 'firefox',
      executablePath: executable(
        [process.env.FIREFOX_EXECUTABLE_PATH ?? '', '/usr/bin/firefox'],
        'Firefox',
      ),
    },
  ];

  try {
    for (const browserCase of cases) await verifyCase(browserCase, url);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
