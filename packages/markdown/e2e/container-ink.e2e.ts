import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer, { type Browser } from 'puppeteer-core';
import { type BrowserCase, bothEngines, closeServer } from '../../core/e2e/_shared/browsers';

/**
 * `:::note … :::` must actually paint its background fill and accent border
 * on the canvas, not merely build the right entity tree.
 *
 * The unit suite (`test/container.test.ts`) asserts entity shape and the
 * border's `.color` property, which stops one step short of the canvas: jsdom
 * has no 2D context. This closes that gap — see the module doc in
 * `container-ink.fixture.ts` for exactly what each sampled pixel measures.
 */

interface ContainerCase {
  bgCorner: [number, number, number, number];
  borderPixel: [number, number, number, number];
  text: string;
}

interface ContainerInkResult {
  note: ContainerCase;
  plain: ContainerCase;
}

function isContainerCase(value: unknown): value is ContainerCase {
  return (
    typeof value === 'object' &&
    value !== null &&
    'bgCorner' in value &&
    Array.isArray((value as { bgCorner: unknown }).bgCorner) &&
    'borderPixel' in value &&
    Array.isArray((value as { borderPixel: unknown }).borderPixel) &&
    'text' in value &&
    typeof value.text === 'string'
  );
}

function isContainerInkResult(value: unknown): value is ContainerInkResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'note' in value &&
    isContainerCase(value.note) &&
    'plain' in value &&
    isContainerCase(value.plain)
  );
}

async function verifyCase(browserCase: BrowserCase, url: string): Promise<void> {
  const browser: Browser = await puppeteer.launch({
    browser: browserCase.browser,
    executablePath: browserCase.executablePath,
    headless: true,
    args: browserCase.browser === 'chrome' ? ['--no-sandbox'] : [],
    defaultViewport: { width: 480, height: 200, deviceScaleFactor: 1 },
  });

  try {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(url, { waitUntil: 'networkidle0' });
    await page.waitForFunction('window.__ready === true', { timeout: 10_000 });

    const result: unknown = await page.evaluate(() => Reflect.get(window, '__containerInk'));
    assert.ok(isContainerInkResult(result), `${browserCase.name} returned invalid ink data`);
    const { note, plain } = result;

    assert.equal(note.text, 'encore encore', `${browserCase.name} container text`);
    assert.equal(plain.text, 'encore encore', `${browserCase.name} plain text`);

    // PLAIN CONTROL: nothing painted behind ordinary prose at either sampled
    // spot — both stay fully transparent.
    assert.equal(
      plain.bgCorner[3],
      0,
      `${browserCase.name} plain bg corner was not transparent: ${JSON.stringify(plain.bgCorner)}`,
    );
    assert.equal(
      plain.borderPixel[3],
      0,
      `${browserCase.name} plain border spot was not transparent: ${JSON.stringify(plain.borderPixel)}`,
    );

    // BACKGROUND GATE: the container's `ContainerBackground` fill must reach
    // the canvas at the sampled corner.
    assert.ok(
      note.bgCorner[3] > 0,
      `${browserCase.name} container bg corner has no ink — the background fill did not reach the canvas: ${JSON.stringify(note.bgCorner)}`,
    );

    // BORDER GATE: the accent bar must reach the canvas too, and its color
    // must match the theme's `note` accent (`#38bdf8`) rather than merely
    // being non-transparent — an opaque fill of the WRONG color would still
    // pass a bare alpha check.
    assert.ok(
      note.borderPixel[3] > 200,
      `${browserCase.name} container border pixel is not opaque: ${JSON.stringify(note.borderPixel)}`,
    );
    // #38bdf8 = rgb(56, 189, 248). Allow antialiasing/gamma slack across engines.
    const [r, g, b] = note.borderPixel;
    assert.ok(
      Math.abs(r - 56) < 20 && Math.abs(g - 189) < 20 && Math.abs(b - 248) < 20,
      `${browserCase.name} container border color does not match the note accent: rgb(${r},${g},${b})`,
    );

    assert.deepEqual(pageErrors, []);
    console.log(
      `✓ ${browserCase.name}: bg corner=${JSON.stringify(note.bgCorner)} border=${JSON.stringify(note.borderPixel)} plainBg=${JSON.stringify(plain.bgCorner)}`,
    );
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const fixture = await build({
    entryPoints: [join(packageRoot, 'e2e/container-ink.fixture.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  const fixtureSource = fixture.outputFiles[0]?.text;
  if (!fixtureSource) throw new Error('Failed to bundle the container browser fixture');

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
