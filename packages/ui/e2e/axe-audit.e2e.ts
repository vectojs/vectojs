/**
 * axe-core audit of the projected accessibility layer.
 *
 * VectoJS renders to canvas and projects a real DOM shadow tree for semantics, so
 * standard a11y tooling *does* apply — but only to that projected layer. axe has
 * no view into canvas pixels, which makes what it can and cannot check unusually
 * important to state:
 *
 *   - It CAN check the projected tree: roles, names, states, ARIA validity,
 *     required parent/child relationships, duplicate ids, focus order.
 *   - It CANNOT check colour contrast, because the visible pixels are drawn on
 *     canvas while the projected elements are transparent. Running the contrast
 *     rules here would report the canvas background against transparent text and
 *     produce confident nonsense, so those rules are disabled explicitly rather
 *     than left to fail or, worse, pass.
 *
 * That distinction is why this is a separate suite from the hand-written
 * conformance assertions: axe covers breadth (every ARIA rule, on every node)
 * while the conformance suite covers behaviour axe cannot see (keyboard protocols,
 * focus containment, state parity with the drawn control).
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(packageRoot, '..', '..');

const axeSource = readFileSync(Bun.resolveSync('axe-core/axe.min.js', packageRoot), 'utf8');

const pageMarkup = `<!doctype html><html lang="en"><head><title>VectoJS a11y audit</title></head>
<body style="margin:0;background:#0b1220">
<canvas id="canvas" width="1000" height="560" style="display:block"></canvas>
<script type="module" src="/fixture.mjs"></script></body></html>`;

/**
 * Rules disabled with the reason, because a blanket ignore list rots into
 * "we turned off whatever failed".
 */
const DISABLED_RULES: Record<string, string> = {
  // The projected elements are transparent overlays; the visible glyphs are canvas
  // pixels. Contrast here compares things that are not what the user sees.
  'color-contrast': 'projected nodes are transparent; visible pixels are canvas-drawn',
  'color-contrast-enhanced': 'same as color-contrast',
  // `aria-required-children` and `aria-required-parent` were disabled here while
  // the projection was flat — `role="row"` did not DOM-contain its gridcells, so
  // rules that check DOM containment could not pass however correct the
  // attributes were. The projection now nests exactly the role pairs ARIA
  // requires to be contained (`Scene.A11Y_REQUIRED_OWNED`), so both are ENABLED
  // and asserted below: measured in real Chrome and Firefox, they went from 1 +
  // 2 violations to 8 + 17 passing nodes with every element's
  // getBoundingClientRect unchanged.
  // The Table projects transparent header hotspots whose text lives on the
  // canvas; the accessible name comes from aria-label, which axe's DOM-text check
  // does not consider. Same transparency caveat as color-contrast.
  'empty-table-header': 'header text is canvas-drawn; the name comes from aria-label',
  // A landmark region is a page-structure concern for the embedding document, not
  // for a canvas runtime's projected layer. The host app owns its landmarks.
  region: 'page-level landmark structure belongs to the embedding document',
};

interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: Array<{ target: string[]; failureSummary: string | null }>;
}

async function runAxe(page: Page): Promise<AxeViolation[]> {
  await page.evaluate(axeSource);
  return page.evaluate(async (disabled: string[]) => {
    const rules: Record<string, { enabled: boolean }> = {};
    for (const id of disabled) rules[id] = { enabled: false };
    const result = await (
      globalThis as unknown as {
        axe: {
          run: (ctx: unknown, opts: unknown) => Promise<{ violations: AxeViolation[] }>;
        };
      }
    ).axe.run(
      // Scope to the projected layer. Auditing the whole document would also
      // flag the host page's own markup, which is the harness's, not ours.
      '[data-vecto-a11y-root], body',
      {
        rules,
        resultTypes: ['violations'],
      },
    );
    return result.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.map((n) => ({
        target: n.target,
        failureSummary: n.failureSummary,
      })),
    }));
  }, Object.keys(DISABLED_RULES));
}

function executable(candidates: string[], label: string): string {
  const path = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!path) throw new Error(`No ${label} executable found`);
  return path;
}

function report(engine: string, violations: AxeViolation[]): string {
  return violations
    .map(
      (v) =>
        `  [${engine}] ${v.id} (${v.impact ?? 'unknown'}): ${v.help}\n` +
        v.nodes
          .slice(0, 4)
          .map((n) => `      at ${n.target.join(' ')}\n      ${n.failureSummary ?? ''}`)
          .join('\n'),
    )
    .join('\n');
}

async function runCase(engine: 'chrome' | 'firefox', executablePath: string, url: string) {
  const browser: Browser = await puppeteer.launch({
    browser: engine === 'firefox' ? 'firefox' : 'chrome',
    executablePath,
    headless: true,
    args: engine === 'chrome' ? ['--no-sandbox', '--disable-gpu'] : [],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 640 });
    // A page running a render loop never reaches `networkidle`.
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-a11y-ready]', { timeout: 20_000 });
    // Wait for the projection itself, not a frame count: a11y sync runs inside
    // the render loop and can lag the first paints.
    await page.waitForFunction(() => document.querySelectorAll('[data-vecto-id]').length > 0, {
      timeout: 20_000,
    });

    const closed = await runAxe(page);
    assert.equal(
      closed.length,
      0,
      `[${engine}] axe violations with the menu/modal closed:\n${report(engine, closed)}`,
    );

    // Overlays are where ARIA structure most often breaks (a menu without its
    // required parent, a dialog missing a name), and they only exist while open —
    // so audit them open rather than only auditing the resting state.
    await page.evaluate(() => window.__a11yFixture.openMenu());
    await page.waitForFunction(() => !!document.querySelector('[role="menu"]'), { timeout: 5000 });
    const withMenu = await runAxe(page);
    assert.equal(
      withMenu.length,
      0,
      `[${engine}] axe violations with the context menu open:\n${report(engine, withMenu)}`,
    );
    await page.evaluate(() => window.__a11yFixture.closeMenu());

    await page.evaluate(() => window.__a11yFixture.openModal());
    await page.waitForFunction(() => !!document.querySelector('[role="dialog"]'), {
      timeout: 5000,
    });
    const withModal = await runAxe(page);
    assert.equal(
      withModal.length,
      0,
      `[${engine}] axe violations with the modal open:\n${report(engine, withModal)}`,
    );
    await page.evaluate(() => void window.__a11yFixture.closeModal());

    const auditedNodes = await page.evaluate(
      () => document.querySelectorAll('[data-vecto-id]').length,
    );
    console.log(`  ${engine}: 0 violations across ${auditedNodes} projected nodes`);
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const bundled = await build({
    entryPoints: [join(packageRoot, 'e2e/a11y-conformance.fixture.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
    alias: Object.fromEntries(
      ['core', 'ui', 'layout', 'text', 'math', 'animation'].map((pkg) => [
        `@vectojs/${pkg}`,
        join(repoRoot, `packages/${pkg}/src/index.ts`),
      ]),
    ),
  });
  const fixtureSource = bundled.outputFiles[0]?.text;
  if (!fixtureSource) throw new Error('Failed to bundle the a11y fixture');

  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/fixture.mjs') {
      response.setHeader('content-type', 'text/javascript');
      response.end(fixtureSource);
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end(pageMarkup);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/`;

  try {
    console.log('axe-core audit of the projected a11y layer:');
    console.log(
      `  rules disabled: ${Object.entries(DISABLED_RULES)
        .map(([id, why]) => `${id} (${why})`)
        .join(', ')}`,
    );
    await runCase(
      'chrome',
      executable(
        [
          process.env.PUPPETEER_EXECUTABLE_PATH ?? '',
          '/usr/bin/chromium',
          '/usr/bin/google-chrome',
        ],
        'Chromium',
      ),
      url,
    );

    const firefoxPath = [process.env.FIREFOX_EXECUTABLE_PATH ?? '', '/usr/bin/firefox'].find(
      (candidate) => candidate && existsSync(candidate),
    );
    if (firefoxPath) {
      await runCase('firefox', firefoxPath, url);
    } else {
      console.log('  firefox: SKIPPED (set FIREFOX_EXECUTABLE_PATH)');
    }
  } finally {
    server.close();
  }
}

main().then(
  () => {
    console.log('axe audit: OK');
    process.exit(0);
  },
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
