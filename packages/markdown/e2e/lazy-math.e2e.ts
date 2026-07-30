import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer, { type Browser } from 'puppeteer-core';
import type { LazyMathBrowserResult } from './lazy-math.fixture';

/**
 * The lazy MathJax load, in a real browser.
 *
 * Two things here cannot be checked anywhere else. First, the fixture is bundled
 * with **code splitting**, so this also asserts the structural claim the change
 * exists for: MathJax must land in its own chunk and the entry chunk must not
 * contain it. A unit test cannot see chunk layout. Second, only a real engine
 * decodes the SVG data URI, so `imageDecoded` is what proves the typeset formula
 * is a real raster rather than a placeholder slab.
 */

interface BrowserCase {
  name: string;
  browser: 'chrome' | 'firefox';
  executablePath: string;
}

function executable(candidates: string[], label: string): string {
  const path = candidates.find((candidate) => candidate.length > 0 && existsSync(candidate));
  if (!path) throw new Error(`No ${label} executable found (${candidates.join(', ')})`);
  return path;
}

function isLazyMathResult(value: unknown): value is LazyMathBrowserResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'readyBeforeAnyFormula' in value &&
    typeof value.readyBeforeAnyFormula === 'boolean' &&
    'entityBeforeLoad' in value &&
    typeof value.entityBeforeLoad === 'string' &&
    'entityAfterLoad' in value &&
    typeof value.entityAfterLoad === 'string' &&
    'imageDecoded' in value &&
    typeof value.imageDecoded === 'boolean' &&
    'heightChanged' in value &&
    typeof value.heightChanged === 'boolean' &&
    'heightConsistent' in value &&
    typeof value.heightConsistent === 'boolean' &&
    'secondFormulaSynchronous' in value &&
    typeof value.secondFormulaSynchronous === 'boolean' &&
    'stableSawTypeset' in value &&
    typeof value.stableSawTypeset === 'boolean'
  );
}

async function verifyCase(browserCase: BrowserCase, url: string): Promise<void> {
  const browser: Browser = await puppeteer.launch({
    browser: browserCase.browser,
    executablePath: browserCase.executablePath,
    headless: true,
    args: browserCase.browser === 'chrome' ? ['--no-sandbox'] : [],
    defaultViewport: { width: 640, height: 480, deviceScaleFactor: 1 },
  });

  try {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(url, { waitUntil: 'networkidle0' });
    await page.waitForFunction('window.__ready === true', { timeout: 30_000 });

    const fixtureError: unknown = await page.evaluate(() => window.__lazyMathError);
    assert.equal(fixtureError, undefined, `${browserCase.name} fixture failed: ${fixtureError}`);

    const result: unknown = await page.evaluate(() => window.__lazyMathResult);
    assert.ok(isLazyMathResult(result), `${browserCase.name} returned an invalid result`);

    assert.equal(
      result.readyBeforeAnyFormula,
      false,
      `${browserCase.name}: importing @vectojs/markdown must not load MathJax`,
    );
    assert.equal(
      result.entityBeforeLoad,
      'CodeBlock',
      `${browserCase.name}: a formula awaiting MathJax must show its TeX source`,
    );
    assert.equal(
      result.entityAfterLoad,
      'MarkdownContainer/Image',
      `${browserCase.name}: the formula must be typeset once MathJax lands`,
    );
    assert.equal(
      result.imageDecoded,
      true,
      `${browserCase.name}: the typeset SVG must decode to a real raster`,
    );
    assert.equal(
      result.heightChanged,
      true,
      `${browserCase.name}: the document box must follow the typeset formula`,
    );
    assert.equal(
      result.heightConsistent,
      true,
      `${browserCase.name}: md.height must agree with content.height after the rebuild`,
    );
    assert.equal(
      result.secondFormulaSynchronous,
      true,
      `${browserCase.name}: formulas after the load must typeset synchronously`,
    );
    assert.equal(
      result.stableSawTypeset,
      true,
      `${browserCase.name}: onStable must not observe an untypeset formula`,
    );
    assert.deepEqual(pageErrors, []);
    console.log(`✓ ${browserCase.name}: ${JSON.stringify(result)}`);
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

  // Code splitting is the point: it is how a consumer's bundler keeps MathJax out
  // of the entry chunk, and it is the arrangement this change is meant to enable.
  const fixture = await build({
    entryPoints: [join(packageRoot, 'e2e/lazy-math.fixture.ts')],
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outdir: join(packageRoot, 'e2e'),
    write: false,
    logLevel: 'silent',
  });

  const chunks = new Map<string, string>();
  for (const file of fixture.outputFiles) {
    chunks.set(file.path.slice(file.path.lastIndexOf('/') + 1), file.text);
  }

  const entryName = [...chunks.keys()].find((n) => n.startsWith('lazy-math.fixture'));
  if (!entryName) throw new Error('Failed to bundle the lazy-math fixture entry');

  // Structural assertion: MathJax's IMPLEMENTATION is not in the entry chunk, and
  // it is in some lazily-loaded chunk.
  //
  // Matched on internal class names (`MmlNode`, `TeXAtom`, `SVGWrapper`) rather
  // than on the string "mathjax" or "liteAdaptor". Those appear in the entry
  // legitimately and always will: the dynamic `import("mathjax-full/...")`
  // specifiers are literals in the entry, and `liteAdaptor` is the name this
  // package destructures. An earlier version of this check matched them and
  // failed against a bundle that was in fact splitting correctly.
  const IMPL = /MmlNode|TeXAtom|SVGWrapper|AbstractMmlNode/;
  const entrySource = chunks.get(entryName)!;
  assert.equal(
    IMPL.test(entrySource),
    false,
    'MathJax implementation must not be in the entry chunk; the lazy import is not splitting',
  );
  const mathjaxSomewhere = [...chunks.entries()].some(
    ([name, text]) => name !== entryName && IMPL.test(text),
  );
  assert.equal(mathjaxSomewhere, true, 'MathJax must be present in a lazily-loaded chunk');

  const entryBytes = Buffer.byteLength(entrySource);
  const totalBytes = [...chunks.values()].reduce((sum, t) => sum + Buffer.byteLength(t), 0);
  console.log(
    `  entry chunk ${entryBytes} bytes of ${totalBytes} total across ${chunks.size} chunks`,
  );

  const markup = `<!doctype html><html><body><script type="module" src="/${entryName}"></script></body></html>`;
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/' || pathname === '/index.html') {
      response.setHeader('content-type', 'text/html');
      response.end(markup);
      return;
    }
    const chunk = chunks.get(pathname.slice(1));
    if (chunk !== undefined) {
      response.setHeader('content-type', 'text/javascript');
      response.end(chunk);
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
