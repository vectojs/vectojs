import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function resolveChromium(): string {
  const configured = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
  if (configured) return configured;
  for (const candidate of ['/usr/bin/chromium', '/usr/bin/google-chrome']) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('No Chromium found: set PUPPETEER_EXECUTABLE_PATH or install Chromium');
}

const PAGE = `<!doctype html>
<html>
  <body style="margin:0">
    <canvas id="canvas" width="320" height="200"></canvas>
    <script type="module" src="/fixture.mjs"></script>
  </body>
</html>`;

// The browser fixture, bundled with esbuild so @vectojs/core (and its transitive
// @vectojs/text -> bidi-js) plus the devtools headless entry are inlined into one
// self-contained module — a browser can't resolve those bare specifiers itself.
const FIXTURE_SOURCE = `
import { Entity, Scene } from '@vectojs/core';
import { createEventTrace } from '@vectojs/devtools/headless';

class KeyboardRegion extends Entity {
  constructor() {
    super('keyboard-region');
    this.width = 240;
    this.height = 120;
    this.interactive = true;
    this.on('keydown', (event) => event.preventDefault());
  }
  getA11yAttributes() {
    return { role: 'region', label: 'Keyboard region', tabIndex: 0 };
  }
  render() {}
}

const scene = new Scene(document.getElementById('canvas'), { disableWindowResize: true });
const region = new KeyboardRegion();
scene.add(region);
scene.start();
const trace = createEventTrace(scene);
document.addEventListener('keydown', (event) => {
  window.__nativeDefaultPrevented = event.defaultPrevented;
});
window.__trace = trace;
window.__ready = true;
`;

async function main(): Promise<void> {
  const headlessEntry = join(packageRoot, 'dist/headless.mjs');
  if (!existsSync(headlessEntry)) {
    throw new Error(`Missing ${headlessEntry} — run \`bun run build\` in packages/devtools first.`);
  }
  const bundled = await build({
    stdin: {
      contents: FIXTURE_SOURCE,
      resolveDir: packageRoot,
      sourcefile: 'event-trace.fixture.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  const fixtureSource = bundled.outputFiles[0]?.text;
  if (!fixtureSource) throw new Error('Failed to bundle the devtools e2e fixture.');

  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/' || pathname === '/index.html') {
      response.setHeader('content-type', 'text/html');
      response.end(PAGE);
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
  await new Promise<void>((resolveListen) => server.listen(0, resolveListen));
  const port = (server.address() as { port: number }).port;
  const browser = await puppeteer.launch({
    executablePath: resolveChromium(),
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });

  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0' });
    await page.waitForFunction('window.__ready === true');
    await page.waitForSelector('[role="region"]');
    await page.focus('[role="region"]');
    await page.keyboard.down('Control');
    await page.keyboard.press('z');
    await page.keyboard.up('Control');
    await page.evaluate(() => Promise.resolve());
    const result = await page.evaluate(() => ({
      nativeDefaultPrevented: (window as any).__nativeDefaultPrevented,
      entry: (window as any).__trace.entries.findLast(
        (entry: { type: string; key?: string }) =>
          entry.type === 'keydown' && entry.key?.toLowerCase() === 'z',
      ),
    }));
    assert.equal(result.nativeDefaultPrevented, true, 'VMT handler prevented the native keydown');
    assert.equal(result.entry.targetId, 'keyboard-region', 'trace retained the VMT target');
    assert.equal(result.entry.defaultPrevented, true, 'trace retained the finalized native state');
    console.log('✓ event trace retains finalized keyboard default prevention in Chromium');
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
