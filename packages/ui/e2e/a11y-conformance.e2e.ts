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

    // ---- Per-role keyboard protocol (ARIA APG) -----------------------------
    // Each role has its own contract, and "has a role" does not imply "obeys it".
    // These pin the contracts that are NOT free from native semantics.

    // switch: Space AND Enter both activate. `role="switch"` is projected onto a
    // div, which is not natively activatable, so the Scene synthesises a click
    // from either key for the interactive ARIA roles.
    //
    // Assert the component's own `change` event rather than the projected
    // `aria-checked` value. Two earlier attempts here compared against a
    // pre-read attribute and failed while the component was working correctly:
    // writing `aria-checked` into the DOM is overwritten by the next sync from
    // component state, and reading it before the keypress can be stale by the
    // time the key lands. The event is the contract; the attribute is a mirror
    // of it.
    for (const key of [SPACE_KEY, 'Enter']) {
      await clearEvents(page);
      await page.focus('[role="switch"]');
      await page.keyboard.press(key);
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      );
      const fired = (await readEvents(page)).filter((e) => e.id === 'toggle-notify');
      assert.ok(
        fired.length > 0,
        `[${engine}] switch must fire change on ${key === SPACE_KEY ? 'Space' : 'Enter'}`,
      );
    }

    // radiogroup: Home/End jump to the first/last option. Arrow keys already
    // worked; Home/End did not move at all, which the APG requires.
    const radioIndex = async (): Promise<number> =>
      page.evaluate(() =>
        [...document.querySelectorAll('[role="radio"]')].findIndex(
          (el) => el === document.activeElement,
        ),
      );
    await page.focus('[role="radio"][tabindex="0"]');
    await page.keyboard.press('End');
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    const lastRadio = await radioIndex();
    assert.ok(lastRadio > 0, `[${engine}] End must move to the last radio (index ${lastRadio})`);
    await page.keyboard.press('Home');
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    assert.equal(await radioIndex(), 0, `[${engine}] Home must move to the first radio`);

    // combobox: Escape closes the popup (APG). Verified through aria-expanded
    // rather than pixels, since that is what assistive tech reads.
    await page.focus('[role="combobox"]');
    await page.keyboard.press('Enter');
    await waitForAttr(
      page,
      'dropdown-size',
      'aria-expanded',
      (v) => v === 'true',
      `[${engine}] Enter must open the combobox`,
    );
    await page.keyboard.press('Escape');
    await waitForAttr(
      page,
      'dropdown-size',
      'aria-expanded',
      (v) => v === 'false',
      `[${engine}] Escape must close the combobox`,
    );

    // link: must be a native <a> with an href, so Enter activates and Space does
    // NOT — that asymmetry is part of the link contract and comes free only from
    // the native element.
    assert.equal(
      byId(await readProjection(page), 'link-docs').tag,
      'a',
      `[${engine}] a link must project a native <a>`,
    );

    // ---- Composite widgets: role structure + roving tabindex ---------------
    // Structure first: assistive tech requires these exact nestings, and a
    // missing intermediate role (grid without row, say) breaks navigation even
    // though every individual cell looks correct.
    assert.equal(byRole(nodes, 'tree').length, 1, `[${engine}] expected one tree`);
    assert.ok(byRole(nodes, 'treeitem').length >= 2, `[${engine}] tree needs treeitems`);
    assert.equal(byRole(nodes, 'grid').length, 1, `[${engine}] expected one grid`);
    assert.ok(byRole(nodes, 'row').length >= 3, `[${engine}] grid needs rows`);
    assert.equal(
      byRole(nodes, 'columnheader').length,
      2,
      `[${engine}] grid needs a columnheader per column`,
    );
    assert.ok(byRole(nodes, 'gridcell').length >= 6, `[${engine}] grid needs gridcells`);

    // Each composite exposes exactly ONE tab stop, so Tab enters and leaves the
    // widget rather than walking every row/cell.
    //
    // The grid's stop can sit on a `columnheader` rather than a `gridcell`: the
    // active cell starts at row -1 (the header). Counting only gridcells reports
    // zero stops and looks like a keyboard-unreachable table — it isn't.
    const stopsIn = (roles: string[]): ProjectedNode[] =>
      nodes.filter((n) => n.role !== null && roles.includes(n.role) && n.tabIndex === 0);
    assert.equal(stopsIn(['treeitem']).length, 1, `[${engine}] tree needs exactly one tab stop`);
    assert.equal(
      stopsIn(['gridcell', 'columnheader']).length,
      1,
      `[${engine}] grid needs exactly one tab stop`,
    );

    // `aria-expanded` must be present on a parent treeitem and absent on a leaf —
    // announcing a leaf as collapsed tells a screen-reader user there is content
    // to open that does not exist.
    const treeitems = byRole(nodes, 'treeitem');
    assert.ok(
      treeitems.some((t) => t.expanded === 'false' || t.expanded === 'true'),
      `[${engine}] a parent treeitem must expose aria-expanded`,
    );

    // Arrow keys move the focus within the tree while preserving the single stop.
    const treeStop = stopsIn(['treeitem'])[0]!;
    await page.focus(`[data-vecto-id="${treeStop.id}"]`);
    await page.keyboard.press('ArrowDown');
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    const afterTreeArrow = await readProjection(page);
    assert.equal(
      afterTreeArrow.filter((n) => n.role === 'treeitem' && n.tabIndex === 0).length,
      1,
      `[${engine}] tree must still expose exactly one tab stop after ArrowDown`,
    );
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute('role')),
      'treeitem',
      `[${engine}] ArrowDown must keep focus on a treeitem`,
    );

    // ---- Popover: hiding must hide the whole subtree ------------------------
    // `Overlay.hide()` drops its own `interactive` and prunes its a11y subtree,
    // which looks sufficient — but the projection walk still descended, so a
    // still-interactive CHILD was re-created on the next frame. Measured before
    // the fix: the popover's element was gone while its button stayed projected
    // with tabIndex 0 and a live box, i.e. Tab reached a button inside a hidden
    // popover.
    await page.evaluate(() => window.__a11yFixture.openPopover());
    await page.waitForFunction(() => !!document.querySelector('[data-vecto-id="popover-action"]'), {
      timeout: 5000,
    });
    const popoverFocused = await page.evaluate(() => {
      const el = document.querySelector('[data-vecto-id="popover-action"]') as HTMLElement | null;
      el?.focus();
      return document.activeElement === el;
    });
    assert.ok(popoverFocused, `[${engine}] a popover child must be focusable while shown`);

    await page.evaluate(() => window.__a11yFixture.closePopover());
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    const afterHide = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      return {
        childProjected: !!document.querySelector('[data-vecto-id="popover-action"]'),
        panelProjected: !!document.querySelector('[data-vecto-id="popover-menu"]'),
        strandedOnBody: active === document.body,
      };
    });
    assert.ok(
      !afterHide.childProjected,
      `[${engine}] hiding a popover must un-project its children, not just itself`,
    );
    assert.ok(!afterHide.panelProjected, `[${engine}] hidden popover must not stay projected`);
    assert.ok(
      !afterHide.strandedOnBody,
      `[${engine}] hiding a popover with focus inside must not drop focus to <body>`,
    );

    // ---- Virtualized list: focus across row recycling ----------------------
    // The fragile boundary: a row holding focus is recycled out as the viewport
    // moves. Dropping focus to <body> there strands a keyboard user at the top of
    // the page with no indication of what happened.
    const mountedRows = await page.evaluate(
      () => document.querySelectorAll('[data-vecto-id^="vrow-"]').length,
    );
    assert.ok(mountedRows > 0, `[${engine}] virtualized list projected no rows`);
    assert.ok(
      mountedRows < 100,
      `[${engine}] expected only the visible window to be projected, got ${mountedRows} of 400`,
    );

    // Each row must state its REAL position: only the mounted window exists in
    // the DOM, so without this the list is announced as "item 3 of 12".
    const rowSet = await page.evaluate(() => {
      const row = document.querySelector('[data-vecto-id^="vrow-"]');
      return {
        posInSet: row?.getAttribute('aria-posinset') ?? null,
        setSize: row?.getAttribute('aria-setsize') ?? null,
      };
    });
    assert.equal(rowSet.setSize, '400', `[${engine}] row must report the full set size`);
    assert.ok(
      rowSet.posInSet !== null && Number(rowSet.posInSet) >= 1,
      `[${engine}] row must report its position in the set`,
    );

    const focusedRow = await page.evaluate(() => {
      const row = document.querySelector('[data-vecto-id^="vrow-"]') as HTMLElement | null;
      row?.focus();
      return document.activeElement === row;
    });
    assert.ok(focusedRow, `[${engine}] a virtualized row must be focusable`);

    await page.evaluate(() => window.__a11yFixture.recycleRows());
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );

    const afterRecycle = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      return {
        strandedOnBody: active === document.body,
        onSentinel: !!active?.hasAttribute?.('data-vecto-focus-sentinel'),
      };
    });
    assert.ok(
      !afterRecycle.strandedOnBody,
      `[${engine}] recycling a focused row must not drop focus to <body>`,
    );
    assert.ok(
      afterRecycle.onSentinel,
      `[${engine}] focus should land on the sentinel after its row is recycled`,
    );

    // ---- Context menu ------------------------------------------------------
    await page.evaluate(() => window.__a11yFixture.openMenu());
    await page.waitForFunction(() => !!document.querySelector('[role="menu"]'), { timeout: 5000 });
    const menuNodes = await readProjection(page);
    assert.equal(byRole(menuNodes, 'menu').length, 1, `[${engine}] expected one menu`);
    const menuItems = byRole(menuNodes, 'menuitem');
    assert.ok(menuItems.length >= 3, `[${engine}] menu needs menuitems`);
    // A separator must not be projected as a menuitem, or it becomes a focusable
    // stop that announces nothing.
    assert.ok(
      menuItems.every((m) => m.label !== null && m.label.trim() !== ''),
      `[${engine}] every menuitem needs an accessible name`,
    );
    await page.evaluate(() => window.__a11yFixture.closeMenu());
    await page.waitForFunction(() => !document.querySelector('[role="menu"]'), { timeout: 5000 });

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

    // Assert Enter and Space SEPARATELY, each waiting for its own activation.
    //
    // Pressing both then counting 2 events is unreliable: CI's Firefox reported
    // only 1, and both keys work in isolation locally, so the two presses arrive
    // close enough together there to be coalesced. Counting a total also cannot
    // say WHICH key failed — this reports the specific one, which is the whole
    // point of asserting a keyboard contract.
    for (const key of ['Enter', SPACE_KEY]) {
      await clearEvents(page);
      await page.focus('[data-vecto-id="btn-submit"]');
      await page.keyboard.press(key);
      try {
        await page.waitForFunction(
          () => window.__a11yFixture.events.some((e) => e.id === 'btn-submit'),
          { timeout: 5000 },
        );
      } catch {
        assert.fail(`[${engine}] button must activate on ${key === SPACE_KEY ? 'Space' : 'Enter'}`);
      }
    }

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
    //
    // Waits for the event rather than reading immediately after the keypress. The
    // immediate read passed locally and failed on CI's Firefox: a native
    // `<input type=checkbox>` dispatches its click/change asynchronously, so
    // whether the event has landed by the next statement is a race that a slower
    // machine loses. Polling makes the assertion depend on the behaviour rather
    // than on the host's speed.
    await clearEvents(page);
    await page.focus('[data-vecto-id="checkbox-terms"]');
    await page.keyboard.press(SPACE_KEY);
    try {
      await page.waitForFunction(
        () => window.__a11yFixture.events.some((e) => e.id === 'checkbox-terms'),
        { timeout: 5000 },
      );
    } catch {
      assert.fail(`[${engine}] checkbox must toggle on Space`);
    }

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

    // ---- Modal: dialog semantics, focus containment, restoration -----------
    // The WAI-ARIA dialog pattern is the easiest thing here to get subtly wrong
    // and the most disruptive when wrong: focus that escapes a modal leaves a
    // keyboard user operating controls they cannot see.
    await page.focus('[data-vecto-id="btn-submit"]');
    const beforeOpen = await page.evaluate(
      () => document.activeElement?.getAttribute('data-vecto-id') ?? null,
    );

    await page.evaluate(() => window.__a11yFixture.openModal());
    await page.waitForFunction(() => !!document.querySelector('[data-vecto-id="modal-confirm"]'), {
      timeout: 5000,
    });
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );

    const dialog = await page.evaluate(() => {
      const el = document.querySelector('[data-vecto-id="modal-confirm"]') as HTMLElement | null;
      if (!el) return null;
      return {
        role: el.getAttribute('role'),
        ariaModal: el.getAttribute('aria-modal'),
        tabIndex: el.tabIndex,
        focusedInside: el.contains(document.activeElement),
        focusedId: document.activeElement?.getAttribute('data-vecto-id') ?? null,
      };
    });
    assert.ok(dialog, `[${engine}] modal did not project a dialog node`);
    assert.equal(dialog.role, 'dialog', `[${engine}] modal must project role=dialog`);
    assert.equal(dialog.ariaModal, 'true', `[${engine}] modal must project aria-modal`);
    // Focus must MOVE INTO the dialog on open, or Escape and screen-reader
    // context never reach it.
    assert.ok(
      dialog.focusedInside || dialog.focusedId === 'modal-confirm',
      `[${engine}] opening a modal must move focus into it (focus was "${dialog.focusedId}")`,
    );

    // Tab must stay inside the dialog, in BOTH directions. `aria-modal` only
    // tells assistive tech that outside content is inert; it does not constrain
    // the browser's tab order, so without an explicit trap a keyboard user walks
    // the page behind the dialog. Assert against the background control ids
    // rather than DOM containment: the a11y projection is flat (every element is
    // a sibling under a11yRoot, ordered by sorting), so
    // `dialog.contains(child)` is always false and would prove nothing.
    const backgroundIds = new Set(named);
    const visited: Array<{ id: string | null; background: boolean }> = [];
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      visited.push(
        await page.evaluate(
          (bg: string[]) => {
            const id = document.activeElement?.getAttribute('data-vecto-id') ?? null;
            return { id, background: id !== null && bg.includes(id) };
          },
          [...backgroundIds],
        ),
      );
    }
    for (let i = 0; i < 6; i++) {
      await page.keyboard.down('Shift');
      await page.keyboard.press('Tab');
      await page.keyboard.up('Shift');
      visited.push(
        await page.evaluate(
          (bg: string[]) => {
            const id = document.activeElement?.getAttribute('data-vecto-id') ?? null;
            return { id, background: id !== null && bg.includes(id) };
          },
          [...backgroundIds],
        ),
      );
    }
    const escaped = visited.filter((v) => v.background);
    assert.equal(
      escaped.length,
      0,
      `[${engine}] Tab escaped the modal to background control(s): ${escaped
        .map((v) => v.id)
        .join(', ')}`,
    );

    // Escape closes it from a CHILD control, not just from the dialog surface.
    //
    // This is deliberately asserted after the Tab test, which leaves focus on a
    // button inside the dialog — the normal state for a real user. The modal's
    // entity-level keydown only fires while its own element is focused, so Escape
    // silently stopped working the moment focus moved inward. It failed on CI
    // (Chrome) even with three retries, which is what distinguished a real bug
    // from the timing flakes elsewhere in this file.
    // Focus the modal's OK button explicitly rather than relying on wherever the
    // Tab loop above happened to stop. That difference is the whole reason this
    // only failed on CI: locally Tab landed on the modal's own close hotspot,
    // where the entity-level handler still fires, so the bug was invisible.
    const focusedChild = await page.evaluate(() => {
      const child = document.querySelector('[data-vecto-id="modal-ok"]') as HTMLElement | null;
      child?.focus();
      return document.activeElement?.getAttribute('data-vecto-id') ?? null;
    });
    assert.equal(
      focusedChild,
      'modal-ok',
      `[${engine}] expected focus on the dialog's OK button before testing Escape`,
    );

    // Re-assert focus immediately before the keypress, and retry.
    //
    // CI reported `activeTag: BODY` at failure time even though the assertion that
    // focus reached `modal-ok` had already passed — so focus was being taken away
    // between the two statements. A projected element can lose focus when its
    // node is re-created by an a11y sync (the element the test focused is gone,
    // and `focus()` on a detached node is a silent no-op), which is timing
    // dependent and therefore CI-visible only.
    //
    // Five attempts to reproduce that locally failed, including on two pinned
    // cores. So rather than keep guessing at the trigger, this re-focuses a FRESH
    // query of the element on each attempt and asserts the outcome. Escape closing
    // the dialog is the contract; which DOM node instance carried focus is not.
    let modalClosed = false;
    let lastState = '';
    for (let attempt = 0; attempt < 3 && !modalClosed; attempt++) {
      const focused = await page.evaluate(() => {
        const child = document.querySelector('[data-vecto-id="modal-ok"]') as HTMLElement | null;
        const target = child ?? (document.querySelector('[role="dialog"]') as HTMLElement | null);
        target?.focus();
        return document.activeElement?.getAttribute('data-vecto-id') ?? null;
      });
      await page.keyboard.press('Escape');
      try {
        await page.waitForFunction(
          () => !document.querySelector('[data-vecto-id="modal-confirm"]'),
          { timeout: 3000 },
        );
        modalClosed = true;
      } catch {
        lastState = await page.evaluate(
          (focusedId: string | null) =>
            JSON.stringify({
              focusedBeforeKey: focusedId,
              activeAtFailure: document.activeElement?.getAttribute('data-vecto-id') ?? null,
              activeTag: document.activeElement?.tagName ?? null,
              modalPresent: !!document.querySelector('[data-vecto-id="modal-confirm"]'),
              okPresent: !!document.querySelector('[data-vecto-id="modal-ok"]'),
            }),
          focused,
        );
      }
    }
    assert.ok(
      modalClosed,
      `[${engine}] Escape must close the modal from a focused child — last state: ${lastState}`,
    );

    // …and focus returns to whatever held it before opening. Landing on <body>
    // instead would silently reset a keyboard user to the top of the page.
    const afterClose = await page.evaluate(
      () => document.activeElement?.getAttribute('data-vecto-id') ?? null,
    );
    assert.equal(
      afterClose,
      beforeOpen,
      `[${engine}] closing a modal must restore focus to "${beforeOpen}", got "${afterClose}"`,
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
