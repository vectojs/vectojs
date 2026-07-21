/**
 * HiDPI end-to-end check: runs a real Chromium page at deviceScaleFactor 2
 * and verifies the behaviors that jsdom cannot — displayed CSS box size,
 * pointer→scene hit-testing, and Scene remount stability on the same canvas.
 *
 * Run with `bun run test:e2e` (builds are NOT triggered here — run
 * `bun run build` first). Chromium resolution order matches video-exporter:
 * PUPPETEER_EXECUTABLE_PATH → /usr/bin/chromium → /usr/bin/google-chrome.
 */
import puppeteer from 'puppeteer-core';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function resolveChromium(): string {
  const configured = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
  if (configured) return configured;
  for (const candidate of ['/usr/bin/chromium', '/usr/bin/google-chrome']) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('No Chromium found: set PUPPETEER_EXECUTABLE_PATH or install /usr/bin/chromium');
}

const PAGE = `<!doctype html>
<html><body style="margin:0">
<canvas id="c" width="300" height="200"></canvas>
<script type="module">
  import { Scene, Entity } from '/bundle.mjs';

  class Target extends Entity {
    hits = [];
    isPointInside(x, y) {
      const l = this.worldToLocal(x, y);
      return !!l && l.x >= 0 && l.x <= 100 && l.y >= 0 && l.y <= 60;
    }
    render(r) {
      r.beginPath();
      r.roundRect(0, 0, 100, 60, 6);
      r.fill('#00f0ff');
    }
  }

  const canvas = document.getElementById('c');
  const scene = new Scene(canvas, { disableWindowResize: true });
  const target = new Target('target');
  target.setPosition(120, 80); // occupies scene rect (120,80)–(220,140)
  target.interactive = true;
  target.width = 100;
  target.height = 60;
  target.on('click', (e) => target.hits.push({ x: e.sceneX, y: e.sceneY }));
  scene.add(target);
  scene.start();

  window.__vecto = {
    scene,
    target,
    canvas,
    remount() {
      scene.destroy();
      const second = new Scene(canvas, { disableWindowResize: true });
      return { width: second.width, height: second.height, backing: canvas.width };
    },
  };
  window.__ready = true;
</script>
</body></html>`;

async function main() {
  // Bundle the built dist so the page loads a single self-contained module:
  // core's dist externalizes @vectojs/{text,layout,math,animation} as bare
  // specifiers a browser can't resolve, so esbuild inlines them from
  // node_modules. This still exercises the published dist artifact.
  const distEntry = join(pkgRoot, 'dist/index.mjs');
  if (!existsSync(distEntry)) {
    throw new Error(`Missing ${distEntry} — run \`bun run build\` in packages/core first.`);
  }
  const bundled = await build({
    entryPoints: [distEntry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  const bundleSource = bundled.outputFiles[0]?.text;
  if (!bundleSource) throw new Error('Failed to bundle packages/core dist for the e2e page.');

  // Tiny static server: "/" serves the page, "/bundle.mjs" the inlined bundle.
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/' || pathname === '/index.html') {
      res.setHeader('content-type', 'text/html');
      res.end(PAGE);
      return;
    }
    if (pathname === '/bundle.mjs') {
      res.setHeader('content-type', 'text/javascript');
      res.end(bundleSource);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;

  const browser = await puppeteer.launch({
    executablePath: resolveChromium(),
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
    defaultViewport: { width: 800, height: 600, deviceScaleFactor: 2 },
  });

  try {
    const page = await browser.newPage();
    page.on('pageerror', (err) => {
      throw new Error(`page error: ${err.message}`);
    });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0' });
    await page.waitForFunction('window.__ready === true', { timeout: 10_000 });

    // 1. Backing store is logical × 2; the displayed CSS box stays logical.
    const sizes = await page.evaluate(() => {
      const { canvas, scene } = (window as any).__vecto;
      const rect = canvas.getBoundingClientRect();
      return {
        sceneW: scene.width,
        sceneH: scene.height,
        backingW: canvas.width,
        backingH: canvas.height,
        cssW: rect.width,
        cssH: rect.height,
      };
    });
    assert.equal(sizes.sceneW, 300, 'scene logical width');
    assert.equal(sizes.sceneH, 200, 'scene logical height');
    assert.equal(sizes.backingW, 600, 'backing store width at DPR 2');
    assert.equal(sizes.backingH, 400, 'backing store height at DPR 2');
    assert.equal(sizes.cssW, 300, 'displayed CSS width stays logical at DPR 2');
    assert.equal(sizes.cssH, 200, 'displayed CSS height stays logical at DPR 2');
    console.log('✓ backing store 2×, displayed box logical');

    // 2. Real pointer input at DPR 2 hits the entity at scene coordinates.
    await page.mouse.click(170, 110); // center of the target's scene rect
    const hits = await page.evaluate(() => (window as any).__vecto.target.hits);
    assert.equal(hits.length, 1, 'click reached the entity');
    assert.ok(
      Math.abs(hits[0].x - 170) <= 1 && Math.abs(hits[0].y - 110) <= 1,
      `hit scene coords ≈ (170,110), got (${hits[0].x},${hits[0].y})`,
    );
    console.log('✓ pointer→scene hit-testing exact at DPR 2');

    // 3. Remounting a Scene on the same canvas does not compound the DPR scale.
    const remount = await page.evaluate(() => (window as any).__vecto.remount());
    assert.equal(remount.width, 300, 'remounted scene width stays logical');
    assert.equal(remount.backing, 600, 'backing store not re-scaled on remount');
    console.log('✓ remount stable (no 300 → 600 → 1200 compounding)');

    console.log('\nHiDPI e2e: all checks passed at deviceScaleFactor 2');
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
