/**
 * Browser regression coverage for the canvas-to-DOM typography contract.
 *
 * The fixture bundles the source components for a real Chromium page, so it
 * catches browser typography geometry rather than only inspecting jsdom styles.
 * `bun run test:e2e` still runs after a build because its HiDPI companion
 * consumes the core distribution.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
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
  throw new Error('No Chromium found: set PUPPETEER_EXECUTABLE_PATH or install /usr/bin/chromium');
}

const PAGE = `<!doctype html><html><body style="margin:0"><canvas id="canvas" width="800" height="520" style="display:block"></canvas><script type="module" src="/fixture.mjs"></script></body></html>`;

async function main() {
  const fixture = await build({
    entryPoints: [join(packageRoot, 'e2e/text-projection.fixture.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  const fixtureSource = fixture.outputFiles[0]?.text;
  if (!fixtureSource) throw new Error('Failed to bundle the text projection browser fixture');

  const server = createServer(async (req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.setHeader('content-type', 'text/html');
      res.end(PAGE);
      return;
    }
    if (req.url === '/fixture.mjs') {
      res.setHeader('content-type', 'text/javascript');
      res.end(fixtureSource);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise<void>((done) => server.listen(0, done));
  const port = (server.address() as { port: number }).port;
  const browser = await puppeteer.launch({
    executablePath: resolveChromium(),
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
    defaultViewport: { width: 800, height: 520, deviceScaleFactor: 1 },
  });

  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0' });
    await page.waitForFunction('window.__ready === true', { timeout: 10_000 });

    const baselines = await page.evaluate(() => {
      const app = (window as any).__vecto;
      const projected = (entity: any, line: number) =>
        app.lineBaseline(app.scene.getContentElement(entity.id), line);
      const textLine = app.text.getContentProjection().lines[0];
      const codeLines = app.code.getContentProjection().lines;
      const richLine = app.rich.getContentProjection().lines[0];
      return {
        text: {
          actual: projected(app.text, 0),
          expected: app.text.y + textLine.y + textLine.baseline,
        },
        code: {
          actual: projected(app.code, 1),
          expected: app.code.y + codeLines[1].y + codeLines[1].baseline,
        },
        rich: {
          actual: projected(app.rich, 0),
          expected: app.rich.y + richLine.y + richLine.baseline,
        },
        textarea: (() => {
          const element = app.scene.getA11yElement(app.area.id);
          const style = getComputedStyle(element);
          return {
            font: style.font,
            lineHeight: style.lineHeight,
            padding: style.padding,
            boxSizing: style.boxSizing,
          };
        })(),
      };
    });

    for (const [name, values] of Object.entries(baselines)) {
      if (name === 'textarea') continue;
      const { actual, expected } = values as { actual: number; expected: number };
      assert.ok(
        Math.abs(actual - expected) <= 1,
        `${name} baseline: expected ${expected}, got ${actual}`,
      );
    }
    assert.match(baselines.textarea.font, /16px/);
    assert.equal(baselines.textarea.lineHeight, '22.4px');
    assert.equal(baselines.textarea.padding, '10px');
    assert.equal(baselines.textarea.boxSizing, 'border-box');
    console.log('✓ Text, CodeBlock, and RichText selection baselines match canvas');
    console.log('✓ TextArea shadow typography matches its canvas editor contract');

    // The real textarea owns editing. Clicking the second visual row must put
    // its native caret into the second source line, rather than a mismatched
    // default-font/default-padding line grid.
    await page.mouse.click(475, 82);
    const caret = await page.evaluate(() => {
      const app = (window as any).__vecto;
      const element = app.scene.getA11yElement(app.area.id) as HTMLTextAreaElement;
      return { focused: document.activeElement === element, start: element.selectionStart };
    });
    assert.equal(caret.focused, true, 'textarea receives the pointer');
    assert.ok(
      caret.start >= 6,
      `second-row click should reach second line, got offset ${caret.start}`,
    );
    console.log('✓ TextArea second-row click maps into the second source line');
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
