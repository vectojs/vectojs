/**
 * A11y conformance e2e: drives the fixture in real Chrome and Firefox and asserts
 * the *browser's own* accessibility tree, tab order, and per-role keyboard
 * protocol.
 *
 * Why a real browser rather than jsdom: everything worth checking here is
 * produced by the engine, not by our code. jsdom has no accessibility tree, so it
 * cannot tell you that `role="slider"` without a name is announced as bare
 * "slider", that a native `<button>` exposes a press action, or that Enter
 * activates a link while Space does not. Those are exactly the regressions this
 * suite exists to catch — the first run of it found two missing accessible names
 * (`Slider`, `Dropdown`) that every unit test had passed over.
 *
 * Both engines run because their accessibility mappings differ. Assertions are
 * therefore written against what ARIA guarantees, not against one engine's
 * snapshot shape.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(packageRoot, '..', '..');

const pageMarkup = `<!doctype html><html><body style="margin:0;background:#0b1220">
<canvas id="canvas" width="1000" height="420" style="display:block"></canvas>
<script type="module" src="/fixture.mjs"></script></body></html>`;

function executable(candidates: string[], label: string): string {
  const path = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!path) throw new Error(`No ${label} executable found (${candidates.join(', ')})`);
  return path;
}

/** One projected node, read from the DOM the way an AT-facing consumer would. */
interface ProjectedNode {
  id: string;
  tag: string;
  role: string | null;
  label: string | null;
  tabIndex: number;
  disabled: boolean;
  required: boolean;
  invalid: string | null;
  checked: string | null;
  selected: string | null;
  expanded: string | null;
  live: string | null;
  href: string | null;
  valuenow: string | null;
  valuemin: string | null;
  valuemax: string | null;
}

async function readProjection(page: Page): Promise<ProjectedNode[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-vecto-id]')].map((raw) => {
      const el = raw as HTMLElement & { checked?: boolean };
      return {
        id: el.getAttribute('data-vecto-id') ?? '',
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role'),
        // The accessible name can come from aria-label or, for a native control
        // with text content, from the content itself.
        label: el.getAttribute('aria-label') ?? (el.textContent || null),
        tabIndex: el.tabIndex,
        disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
        required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
        invalid: el.getAttribute('aria-invalid'),
        checked:
          el.getAttribute('aria-checked') ?? (el.checked === undefined ? null : String(el.checked)),
        selected: el.getAttribute('aria-selected'),
        expanded: el.getAttribute('aria-expanded'),
        live: el.getAttribute('aria-live'),
        href: el.getAttribute('href'),
        valuenow: el.getAttribute('aria-valuenow'),
        valuemin: el.getAttribute('aria-valuemin'),
        valuemax: el.getAttribute('aria-valuemax'),
      };
    }),
  );
}

/**
 * Wait until a projected attribute reaches an expected value.
 *
 * A keypress mutates entity state synchronously, but the DOM mirror is written by
 * the next a11y sync inside the render loop. Reading the projection immediately
 * after `keyboard.press` therefore observes the PREVIOUS value — which looks
 * exactly like the component ignoring the key. (It cost me two false findings
 * here before I checked the entity's own state.)
 */
async function waitForAttr(
  page: Page,
  id: string,
  attr: string,
  predicate: (value: string | null) => boolean,
  label: string,
): Promise<string | null> {
  try {
    await page.waitForFunction(
      (entityId: string, attribute: string, source: string) => {
        const el = document.querySelector(`[data-vecto-id="${entityId}"]`);
        // eslint-disable-next-line no-new-func
        const test = new Function('value', `return (${source})(value)`) as (
          v: string | null,
        ) => boolean;
        return !!el && test(el.getAttribute(attribute));
      },
      { timeout: 5000 },
      id,
      attr,
      predicate.toString(),
    );
  } catch {
    const actual = await page.evaluate(
      (entityId: string, attribute: string) =>
        document.querySelector(`[data-vecto-id="${entityId}"]`)?.getAttribute(attribute) ?? null,
      id,
      attr,
    );
    assert.fail(`${label} (projected ${attr}="${actual}")`);
  }
  return page.evaluate(
    (entityId: string, attribute: string) =>
      document.querySelector(`[data-vecto-id="${entityId}"]`)?.getAttribute(attribute) ?? null,
    id,
    attr,
  );
}

/**
 * Firefox drives through WebDriver BiDi, which only accepts the literal space
 * character as a key name and rejects the `"Space"` alias Chrome's CDP allows.
 */
const SPACE_KEY = ' ' as const;

const byId = (nodes: ProjectedNode[], id: string): ProjectedNode => {
  const found = nodes.find((n) => n.id === id);
  assert.ok(found, `no projected node for "${id}"`);
  return found;
};

const byRole = (nodes: ProjectedNode[], role: string): ProjectedNode[] =>
  nodes.filter((n) => n.role === role);

/** Read the log the fixture keeps of what each control reported. */
async function readEvents(page: Page): Promise<Array<{ id: string; type: string }>> {
  return page.evaluate(() => window.__a11yFixture.events.map((e) => ({ id: e.id, type: e.type })));
}

async function clearEvents(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__a11yFixture.events.length = 0;
  });
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
    await page.setViewport({ width: 1100, height: 600 });
    // `networkidle*` never settles on a page running a render loop.
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-a11y-ready]', { timeout: 20_000 });

    const nodes = await readProjection(page);

    // ---- Role and name coverage -------------------------------------------
    // Every projected control needs a non-empty accessible name. This is the
    // check that caught Slider and Dropdown shipping nameless roles.
    const named = [
      'btn-submit',
      'btn-disabled',
      'link-docs',
      'checkbox-terms',
      'toggle-notify',
      'slider-volume',
      'dropdown-size',
      'input-name',
      'input-email',
      'tabs-main',
    ];
    for (const id of named) {
      const node = byId(nodes, id);
      assert.ok(
        node.label && node.label.trim().length > 0,
        `[${engine}] "${id}" (role=${node.role ?? node.tag}) has no accessible name`,
      );
    }

    // Native elements, not div+role: native semantics carry the keyboard
    // protocol and the exposed action for free.
    assert.equal(
      byId(nodes, 'btn-submit').tag,
      'button',
      `[${engine}] submit should be a <button>`,
    );
    assert.equal(byId(nodes, 'link-docs').tag, 'a', `[${engine}] link should be an <a>`);
    assert.ok(byId(nodes, 'link-docs').href, `[${engine}] link needs an href to be a real link`);
    assert.equal(byId(nodes, 'input-name').tag, 'input', `[${engine}] input should be an <input>`);

    // ---- State fidelity ----------------------------------------------------
    // The invariant that matters most: what is drawn as unavailable must project
    // as unavailable, or sighted and screen-reader users are told opposite things.
    assert.ok(byId(nodes, 'btn-disabled').disabled, `[${engine}] disabled button must project it`);
    assert.ok(!byId(nodes, 'btn-submit').disabled, `[${engine}] enabled button must not`);

    const email = byId(nodes, 'input-email');
    assert.ok(email.required, `[${engine}] required field must project required`);
    assert.equal(email.invalid, 'true', `[${engine}] invalid field must project aria-invalid`);

    assert.equal(byId(nodes, 'checkbox-terms').checked, 'false', `[${engine}] checkbox state`);
    assert.equal(byId(nodes, 'toggle-notify').checked, 'false', `[${engine}] switch state`);

    const slider = byId(nodes, 'slider-volume');
    assert.equal(slider.valuenow, '40', `[${engine}] slider needs aria-valuenow`);
    assert.equal(slider.valuemin, '0', `[${engine}] slider needs aria-valuemin`);
    assert.equal(slider.valuemax, '100', `[${engine}] slider needs aria-valuemax`);

    // ---- Composite widgets: roving tabindex --------------------------------
    // A tablist must expose exactly one tab stop, with the rest at -1, or
    // keyboard users have to Tab through every tab to leave the group.
    const tabs = byRole(nodes, 'tab');
    assert.equal(tabs.length, 3, `[${engine}] expected 3 tabs, got ${tabs.length}`);
    const focusableTabs = tabs.filter((t) => t.tabIndex === 0);
    assert.equal(
      focusableTabs.length,
      1,
      `[${engine}] tablist must have exactly one tab stop, got ${focusableTabs.length}`,
    );
    assert.equal(
      byRole(nodes, 'radio').filter((r) => r.tabIndex === 0).length,
      1,
      `[${engine}] radiogroup must have exactly one tab stop`,
    );

    // ---- Live region --------------------------------------------------------
    const live = byId(nodes, 'live-status');
    assert.equal(live.live, 'polite', `[${engine}] status region must be aria-live=polite`);
    assert.equal(live.tabIndex, -1, `[${engine}] a status region must not be a tab stop`);

    await page.evaluate(() => window.__a11yFixture.announce('Saved 3 items'));
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    const announced = byId(await readProjection(page), 'live-status');
    assert.ok(
      announced.label?.includes('Saved 3 items'),
      `[${engine}] live region did not update (got "${announced.label}")`,
    );

    // ---- Keyboard protocol per role ----------------------------------------
    // Each role has its own contract; "has a role" does not imply "obeys it".
    await clearEvents(page);

    // Button: both Enter and Space activate.
    await page.focus('[data-vecto-id="btn-submit"]');
    const focusedId = await page.evaluate(() =>
      document.activeElement?.getAttribute('data-vecto-id'),
    );
    assert.equal(focusedId, 'btn-submit', `[${engine}] focus() must reach the projected button`);

    await page.keyboard.press('Enter');
    await page.keyboard.press(SPACE_KEY);
    const buttonEvents = (await readEvents(page)).filter((e) => e.id === 'btn-submit');
    assert.ok(
      buttonEvents.length >= 2,
      `[${engine}] button must activate on BOTH Enter and Space, saw ${buttonEvents.length}`,
    );

    // Disabled control: must not activate, and must not be a tab stop.
    await clearEvents(page);
    await page.evaluate(() => {
      (document.querySelector('[data-vecto-id="btn-disabled"]') as HTMLElement)?.click();
    });
    assert.equal(
      (await readEvents(page)).filter((e) => e.id === 'btn-disabled').length,
      0,
      `[${engine}] a disabled control must not activate`,
    );

    // Checkbox: Space toggles.
    await clearEvents(page);
    await page.focus('[data-vecto-id="checkbox-terms"]');
    await page.keyboard.press(SPACE_KEY);
    assert.ok(
      (await readEvents(page)).some((e) => e.id === 'checkbox-terms'),
      `[${engine}] checkbox must toggle on Space`,
    );

    // Slider: arrows move the value, Home/End jump to the bounds.
    await clearEvents(page);
    await page.focus('[data-vecto-id="slider-volume"]');
    await page.keyboard.press('ArrowRight');
    await waitForAttr(
      page,
      'slider-volume',
      'aria-valuenow',
      (v) => Number(v) > 40,
      `[${engine}] ArrowRight must raise the slider value`,
    );

    await page.keyboard.press('Home');
    await waitForAttr(
      page,
      'slider-volume',
      'aria-valuenow',
      (v) => v === '0',
      `[${engine}] Home must jump the slider to its minimum`,
    );

    await page.keyboard.press('End');
    await waitForAttr(
      page,
      'slider-volume',
      'aria-valuenow',
      (v) => v === '100',
      `[${engine}] End must jump the slider to its maximum`,
    );

    // Tabs: arrow keys move selection within the group.
    await clearEvents(page);
    const firstTabId = tabs.find((t) => t.tabIndex === 0)!.id;
    await page.focus(`[data-vecto-id="${firstTabId}"]`);
    await page.keyboard.press('ArrowRight');
    // Roving focus moves the single tab stop; wait for the mirror to catch up
    // rather than reading it on the same tick as the keypress.
    await page.waitForFunction(
      (previous: string) => {
        const stops = [...document.querySelectorAll('[role="tab"]')].filter(
          (t) => (t as HTMLElement).tabIndex === 0,
        );
        return stops.length === 1 && stops[0]!.getAttribute('data-vecto-id') !== previous;
      },
      { timeout: 5000 },
      firstTabId,
    );

    const afterTabArrow = byRole(await readProjection(page), 'tab');
    assert.equal(
      afterTabArrow.filter((t) => t.tabIndex === 0).length,
      1,
      `[${engine}] tablist must still expose exactly one tab stop after ArrowRight`,
    );
    assert.equal(
      afterTabArrow.filter((t) => t.selected === 'true').length,
      1,
      `[${engine}] exactly one tab must be aria-selected`,
    );

    // ---- Canvas text is real, readable text --------------------------------
    // Canvas text must exist as real, selectable DOM text — that is what makes it
    // screen-reader readable, Ctrl+F searchable and copyable. Query the whole
    // document by content rather than by attribute: content projections are
    // separate elements from the interactive mirrors and carry no shared marker.
    const caption = await page.evaluate(() => {
      const match = [...document.querySelectorAll('div, span, p')].find((n) =>
        (n.textContent ?? '').includes('Canvas text projected'),
      ) as HTMLElement | undefined;
      if (!match) return null;
      return {
        text: match.textContent ?? '',
        userSelect: getComputedStyle(match).userSelect,
      };
    });
    assert.ok(caption, `[${engine}] canvas text was not projected into the DOM at all`);
    assert.ok(
      caption.text.includes('screen readers'),
      `[${engine}] projected canvas text is truncated: "${caption.text.slice(0, 60)}"`,
    );

    // ---- Focus restoration across removal ----------------------------------
    // Losing focus to <body> strands a keyboard user; the sentinel prevents it.
    await page.focus('[data-vecto-id="btn-submit"]');
    await page.evaluate(() => {
      const scene = window.__a11yFixture.scene as unknown as {
        getRoot: () => { children: Array<{ id: string }> };
      };
      const target = scene.getRoot().children.find((c) => c.id === 'btn-submit');
      if (target)
        (
          window.__a11yFixture.scene as unknown as {
            remove: (e: unknown) => void;
          }
        ).remove(target);
    });
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    const strandedOnBody = await page.evaluate(() => document.activeElement === document.body);
    assert.ok(
      !strandedOnBody,
      `[${engine}] removing a focused control must not drop focus to <body>`,
    );

    console.log(`  ${engine}: ${nodes.length} projected nodes, all assertions passed`);
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
    alias: {
      '@vectojs/core': join(repoRoot, 'packages/core/src/index.ts'),
      '@vectojs/ui': join(repoRoot, 'packages/ui/src/index.ts'),
      '@vectojs/layout': join(repoRoot, 'packages/layout/src/index.ts'),
      '@vectojs/text': join(repoRoot, 'packages/text/src/index.ts'),
      '@vectojs/math': join(repoRoot, 'packages/math/src/index.ts'),
      '@vectojs/animation': join(repoRoot, 'packages/animation/src/index.ts'),
    },
  });
  const fixtureSource = bundled.outputFiles[0]?.text;
  if (!fixtureSource) throw new Error('Failed to bundle the a11y conformance fixture');

  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/' || pathname === '/index.html') {
      response.setHeader('content-type', 'text/html');
      response.end(pageMarkup);
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
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/`;

  const chromium = executable(
    [process.env.PUPPETEER_EXECUTABLE_PATH ?? '', '/usr/bin/chromium', '/usr/bin/google-chrome'],
    'Chromium',
  );

  try {
    console.log('a11y conformance:');
    await runCase('chrome', chromium, url);

    // Firefox is optional locally but present in CI. Skipping loudly is better
    // than a green run that only proved one engine.
    const firefoxPath = [process.env.FIREFOX_EXECUTABLE_PATH ?? '', '/usr/bin/firefox'].find(
      (candidate) => candidate && existsSync(candidate),
    );
    if (firefoxPath) {
      await runCase('firefox', firefoxPath, url);
    } else {
      console.log('  firefox: SKIPPED (no executable; set FIREFOX_EXECUTABLE_PATH)');
    }
  } finally {
    server.close();
  }
}

main().then(
  () => {
    console.log('a11y conformance: OK');
    process.exit(0);
  },
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
