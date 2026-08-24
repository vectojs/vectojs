import { afterEach, describe, it, expect, vi } from 'vitest';
import { Entity, Scene, type A11yAttributes, type DevtoolsDescriptor } from '@vectojs/core';
import { Button, Stack } from '@vectojs/ui';
import { attachDevtools } from '../src/index';
import { clearDevtoolsPlugins, registerDevtoolsPlugin } from '../src/plugin';

class Box extends Entity {
  constructor(id: string, w = 40, h = 20) {
    super(id);
    this.width = w;
    this.height = h;
  }
  // Rect semantics like a real engine shape — the picker must not need an
  // AABB fallback (#671).
  isPointInside(sceneX: number, sceneY: number): boolean {
    const point = this.worldToLocal(sceneX, sceneY);
    return (
      point !== null &&
      point.x >= 0 &&
      point.y >= 0 &&
      point.x < this.width &&
      point.y < this.height
    );
  }
  render(): void {}
}

function makeHost(): Scene {
  const parent = document.createElement('div');
  const canvas = document.createElement('canvas');
  parent.appendChild(canvas);
  document.body.appendChild(parent);
  return new Scene(canvas, { disableWindowResize: true });
}

/** A Box whose descriptor fills the whole INSPECT_ROWS budget (12 descriptor lines). */
class FullDescBox extends Box {
  public override getDevtoolsDescriptor(): DevtoolsDescriptor {
    return {
      kind: 'busy',
      groups: [
        {
          label: 'state',
          fields: Array.from({ length: 11 }, (_, i) => ({ label: `f${i}`, value: i })),
        },
      ],
    };
  }
}

afterEach(() => clearDevtoolsPlugins());

describe('attachDevtools', () => {
  it('mounts a panel, mirrors the host tree, and tears down cleanly', () => {
    const host = makeHost();
    host.add(new Box('a'));
    host.add(new Box('b'));

    const panel = attachDevtools(host, { refreshInterval: 0 });
    expect(document.querySelector('[data-vecto-devtools]')).not.toBeNull();
    expect((panel as any).index.get('a')).toBeDefined();
    expect((panel as any).index.get('b')).toBeDefined();

    panel.detach();
    expect(document.querySelector('[data-vecto-devtools]')).toBeNull();
    host.destroy();
  });

  it('select() highlights on the host overlay and fills the readout', () => {
    const host = makeHost();
    const target = new Box('sel', 60, 30);
    target.setPosition(15, 25);
    host.add(target);

    const panel = attachDevtools(host, { refreshInterval: 0 });
    panel.select(target);

    expect(panel.selection).toBe(target);
    expect(host.overlayRootEntity.children.length).toBe(1); // highlight entity
    const readout = (panel as any).detailLines.map((l: { text: string }) => l.text).join('\n');
    expect(readout).toContain('#sel');
    expect(readout).toContain('x 15');

    panel.detach();
    expect(host.overlayRootEntity.children.length).toBe(0); // highlight removed
    host.destroy();
  });

  it('armed pick selects the entity under a host click', () => {
    const host = makeHost();
    vi.spyOn(host, 'clientToScene').mockReturnValue({ x: 30, y: 30 });
    const target = new Box('picked', 100, 100);
    host.add(target);

    const panel = attachDevtools(host, { refreshInterval: 0 });
    panel.armPick();
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(panel.selection?.id).toBe('picked');
    panel.detach();
    host.destroy();
  });

  it('an armed pick ignores clicks on the panel controls and stays armed', () => {
    const host = makeHost();
    vi.spyOn(host, 'clientToScene').mockReturnValue({ x: 30, y: 30 });
    const target = new Box('hosty', 100, 100);
    host.add(target);

    const panel = attachDevtools(host, { refreshInterval: 0 });
    panel.armPick();

    // A click whose target lives INSIDE the panel container is panel chrome (the
    // pick button, search, tree rows): the document capture listener must let it
    // through to the control's own handler instead of consuming it as a host
    // pick — before the fix, stopPropagation killed the handler and the pick ran
    // against the panel's own coordinates.
    const dock = document.querySelector('[data-vecto-devtools]') as HTMLElement;
    const control = document.createElement('div');
    dock.appendChild(control);
    const onClick = vi.fn();
    control.addEventListener('click', onClick);
    control.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(panel.selection).toBeNull();

    // The stray panel click did not consume the one-shot pick: the next click
    // outside the panel still performs the host pick.
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(panel.selection?.id).toBe('hosty');

    panel.detach();
    host.destroy();
  });

  it('arrow keys nudge the selected entity (shift ×10)', () => {
    const host = makeHost();
    const target = new Box('nudge');
    target.setPosition(50, 50);
    host.add(target);

    const panel = attachDevtools(host, { refreshInterval: 0 });
    panel.select(target);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(target.x).toBe(51);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true }));
    expect(target.y).toBe(60);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '-' }));
    expect(target.opacity).toBeCloseTo(0.9);

    panel.detach();
    host.destroy();
  });

  it('auto-refresh picks up newly added entities', () => {
    vi.useFakeTimers();
    const host = makeHost();
    const panel = attachDevtools(host, { refreshInterval: 100 });
    host.add(new Box('late'));
    vi.advanceTimersByTime(150);
    expect((panel as any).index.get('late')).toBeDefined();
    panel.detach();
    host.destroy();
    vi.useRealTimers();
  });

  it('audit() reports findings and selectFinding() highlights the offender', () => {
    const host = makeHost();
    host.resize(400, 300);
    const a = new Box('a', 100, 100);
    const b = new Box('b', 100, 100); // fully stacked on a → one overlap finding
    host.add(a);
    host.add(b);

    const panel = attachDevtools(host, { refreshInterval: 0 });
    const findings = panel.audit();
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('overlap');

    panel.selectFinding(0);
    expect(panel.selection).toBe(a);
    const readout = (panel as any).detailLines.map((l: { text: string }) => l.text).join('\n');
    expect(readout).toContain('#a');

    panel.detach();
    host.destroy();
  });

  it('selectFinding resolves a plugin finding row to its entity (unified list)', () => {
    const host = makeHost();
    const target = new Box('plugged');
    host.add(target);
    registerDevtoolsPlugin({
      id: 'aud',
      audits: [
        { id: 'a', run: () => [{ kind: 'thing', entityId: target.id, message: 'went wrong' }] },
      ],
    });

    const panel = attachDevtools(host, { refreshInterval: 0 });
    panel.audit();
    // A clean scene has no scene findings, so the plugin finding is row 0.
    expect(panel.getPluginFindings()).toHaveLength(1);
    panel.selectFinding(0);
    expect(panel.selection?.id).toBe('plugged');

    panel.detach();
    host.destroy();
  });

  it('the transient "owned by parent" warning survives a readout that fills all rows', () => {
    const host = makeHost();
    const stack = new Stack({ direction: 'vertical' });
    host.add(stack);
    const child = new FullDescBox('owned');
    stack.add(child); // Stack owns child.x/y, so the x edit is an override

    const panel = attachDevtools(host, { refreshInterval: 0 });
    panel.select(child);
    (panel as any).applyEdit('x', '5');

    // describeEntity fills all INSPECT_ROWS for this entity; the transient
    // warning appended as a 21st line was silently dropped by the bounded
    // write loop — the one line the user was looking for right now.
    const lines = (panel as any).detailLines.map((l: { text: string }) => l.text);
    expect(lines.join('\n')).toContain('is owned by');

    panel.detach();
    host.destroy();
  });

  it('caches the full-scene a11y audit across refresh ticks (recomputed on structure change)', () => {
    const host = makeHost();
    let a11yCalls = 0;
    class Counting extends Box {
      public override getA11yAttributes(): A11yAttributes {
        a11yCalls++;
        return {};
      }
    }
    const counter = new Counting('cnt');
    host.add(counter);
    const other = new Box('sel');
    host.add(other);

    const panel = attachDevtools(host, { refreshInterval: 0 });
    panel.select(other); // first audit runs here
    const afterSelect = a11yCalls;
    expect(afterSelect).toBeGreaterThan(0);

    // Unchanged structure: the audit must not walk the scene again on the
    // periodic refresh fast path (it used to — every 500ms tick).
    panel.refresh();
    panel.refresh();
    expect(a11yCalls).toBe(afterSelect);

    // A structure bump re-runs the audit once.
    host.add(new Box('late'));
    panel.refresh();
    expect(a11yCalls).toBeGreaterThan(afterSelect);

    panel.detach();
    host.destroy();
  });

  it('audit() on a clean scene reports no findings and refresh restores the tree', () => {
    const host = makeHost();
    host.resize(400, 300);
    const solo = new Box('solo', 50, 50);
    host.add(solo);

    const panel = attachDevtools(host, { refreshInterval: 0 });
    expect(panel.audit()).toEqual([]);
    panel.refresh();
    expect((panel as any).index.get('solo')).toBe(solo);
    panel.detach();
    host.destroy();
  });

  it('exposes an opt-in event trace and tears it down with the panel', async () => {
    const host = makeHost();
    const panel = attachDevtools(host, { refreshInterval: 0, traceEvents: true, traceCapacity: 2 });
    expect(panel.trace).not.toBeNull();

    host.canvas.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    await Promise.resolve();
    expect(panel.trace?.entries).toEqual([
      expect.objectContaining({ type: 'keydown', key: 'Enter' }),
    ]);

    panel.detach();
    host.canvas.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
    await Promise.resolve();
    expect(panel.trace?.entries).toHaveLength(1);
    host.destroy();
  });

  it('does not swallow pointer clicks on host content under the docked panel (findings.md, 2026-07-16)', () => {
    // The dock is `position: fixed; right: 0; width: 320px; height: 100%`
    // (see panel.ts) — a real host page's own right-edge content (its own
    // rightmost tab's ×, toolbar buttons, etc.) sits directly underneath
    // that band. Before the fix, the dock container (and its canvas)
    // defaulted to `pointer-events: auto` (the unset browser default), so
    // ANY click landing in that 320px-wide, full-height rectangle hit the
    // dock's own empty background instead of reaching the host content
    // beneath it — even though the dock had no interactive chrome at that
    // exact pixel. This corrupted a real forge audit's headless interaction
    // test (the finding's own words: "the × was fine; the overlay ate the
    // click").
    //
    // jsdom does not implement real layered hit-testing (elementFromPoint
    // always resolves to <body>, and dispatching a synthetic event directly
    // on a target element bypasses the browser's top-to-bottom hit-test
    // entirely) — so this test cannot literally reproduce "click lands on
    // the dock instead of the host button" the way a real browser/Playwright
    // e2e test would. What IS verifiable here, and is the actual mechanism a
    // real browser's hit-test depends on, is the CSS the fix sets: the dock
    // container and its canvas must be `pointer-events: none` so the
    // browser's hit-test skips them and falls through to whatever host
    // content is underneath — and the panel's OWN interactive controls must
    // still be independently clickable via their a11y shadow elements'
    // `auto` opt-in (verified by exercising the panel's own Pick button,
    // which every other test in this file already relies on working).
    const host = makeHost();
    const hostButton = new Button('Close', { width: 40, height: 20 });
    // Position it inside the dock's real screen-space footprint (dock is
    // 320px wide, right-aligned; jsdom's default viewport is 1024×768, so
    // x=900 sits under the dock at any default width) — documents exactly
    // the geometry a real host app's right-edge content would occupy.
    hostButton.setPosition(900, 50);
    host.add(hostButton);
    (host as unknown as { isRunning: boolean }).isRunning = true;
    (host as unknown as { loop: (t: number) => void }).loop(16); // drive one a11y sync pass so the shadow <button> exists

    const panel = attachDevtools(host, { refreshInterval: 0 });

    const dock = document.querySelector('[data-vecto-devtools]') as HTMLElement;
    expect(dock).not.toBeNull();
    expect(getComputedStyle(dock).pointerEvents).toBe('none');
    const dockCanvas = dock.querySelector('canvas');
    expect(dockCanvas).not.toBeNull();
    expect(getComputedStyle(dockCanvas!).pointerEvents).toBe('none');

    // The host button underneath the dock still owns a real, clickable
    // shadow element — it was never touched by the fix, but this pins that
    // the fix didn't accidentally suppress host-side a11y projection either.
    const hostButtonEl = document.getElementById(hostButton.id);
    expect(hostButtonEl).not.toBeNull();
    expect(getComputedStyle(hostButtonEl!).pointerEvents).toBe('auto');

    panel.detach();
    host.destroy();
  });
});

describe('DevtoolsPanel — modern features', () => {
  it('filters the tree by type/id substring while keeping the full index', () => {
    const host = makeHost();
    host.add(new Box('apple'));
    host.add(new Box('banana'));
    const panel = attachDevtools(host, { refreshInterval: 0 });

    const tree = (panel as any).tree as { setNodes: (n: unknown[]) => void };
    const spy = vi.spyOn(tree, 'setNodes');
    (panel as any).setFilter('banana');

    // The last setNodes call carries only the matching node(s).
    const lastCall = spy.mock.calls.at(-1)?.[0] as Array<{ id: string }>;
    expect(lastCall.some((n) => n.id === 'banana')).toBe(true);
    expect(lastCall.some((n) => n.id === 'apple')).toBe(false);
    // Index still resolves both — filtering is view-only.
    expect((panel as any).index.get('apple')).toBeDefined();

    // Clearing the filter restores every node.
    (panel as any).setFilter('');
    const restored = spy.mock.calls.at(-1)?.[0] as Array<{ id: string }>;
    expect(restored).toHaveLength(2);

    panel.detach();
    host.destroy();
  });

  it('counts total and interactive entities in the header badges', () => {
    const host = makeHost();
    const plain = new Box('plain');
    const clickable = new Box('clickable');
    clickable.interactive = true;
    host.add(plain);
    host.add(clickable);

    const panel = attachDevtools(host, { refreshInterval: 0 });
    expect((panel as any).countPill.label).toBe('2');
    expect((panel as any).interactivePill.label).toContain('1');

    panel.detach();
    host.destroy();
  });

  it('surfaces the audit finding count in the warning badge', () => {
    const host = makeHost();
    host.resize(400, 300);
    host.add(new Box('a', 100, 100));
    host.add(new Box('b', 100, 100)); // overlap → one finding
    const panel = attachDevtools(host, { refreshInterval: 0 });

    panel.audit();
    expect((panel as any).warnPill.label).toContain('1');

    panel.detach();
    host.destroy();
  });

  it('writes live perf lines from Scene.frameStats', () => {
    const host = makeHost();
    const panel = attachDevtools(host, { refreshInterval: 0, showPerf: true });
    (panel as any).writePerf();
    const perf = (panel as any).perfLines.map((l: { text: string }) => l.text).join('\n');
    expect(perf).toContain('fps');
    expect(perf).toContain('ms/frame');
    expect(perf).toMatch(/entities/);

    panel.detach();
    host.destroy();
  });

  it('select() switches to the Inspect tab and syncs the edit fields', () => {
    const host = makeHost();
    const target = new Box('sel', 60, 30);
    target.setPosition(15, 25);
    host.add(target);

    const panel = attachDevtools(host, { refreshInterval: 0, defaultTab: 'tree' });
    panel.select(target);

    expect((panel as any).tabs.value).toBe('inspect');
    expect((panel as any).editX.value).toBe('15');
    expect((panel as any).editY.value).toBe('25');

    panel.detach();
    host.destroy();
  });

  it('inline edit mutates the selected entity and refreshes the readout', () => {
    const host = makeHost();
    const target = new Box('edit', 40, 20);
    target.setPosition(0, 0);
    host.add(target);

    const panel = attachDevtools(host, { refreshInterval: 0 });
    panel.select(target);
    (panel as any).applyEdit('x', '42');
    expect(target.x).toBe(42);
    (panel as any).applyEdit('opacity', '0.3');
    expect(target.opacity).toBeCloseTo(0.3);
    // Bad input is ignored.
    (panel as any).applyEdit('y', 'not-a-number');
    expect(target.y).toBe(0);

    panel.detach();
    host.destroy();
  });

  it('audit() populates the audit tab and switches to it', () => {
    const host = makeHost();
    host.resize(400, 300);
    host.add(new Box('a', 100, 100));
    host.add(new Box('b', 100, 100));
    const panel = attachDevtools(host, { refreshInterval: 0 });

    panel.audit();
    expect((panel as any).tabs.value).toBe('audit');

    panel.detach();
    host.destroy();
  });

  it('copySelection writes the entity path to the clipboard', () => {
    const host = makeHost();
    const target = new Box('copyme');
    host.add(target);

    const writeText = vi.fn();
    (globalThis.navigator as unknown as { clipboard: { writeText: typeof writeText } }).clipboard =
      {
        writeText,
      };

    const panel = attachDevtools(host, { refreshInterval: 0 });
    panel.select(target);
    (panel as any).copySelection('path');
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(String(writeText.mock.calls[0][0])).toContain('Scene >');

    panel.detach();
    host.destroy();
  });

  it('setHighlightLayers drives what the overlay highlight draws', () => {
    const host = makeHost();
    const clipper = new Box('clip', 200, 100);
    clipper.clipChildren = true;
    const target = new Box('sel', 60, 30);
    host.add(clipper);
    clipper.add(target);

    const panel = attachDevtools(host, { refreshInterval: 0 });
    panel.select(target);

    // Default is the single AABB the panel drew before layers existed.
    const highlight = host.overlayRootEntity.children[0] as unknown as {
      render(r: unknown): void;
      layers: ReadonlyArray<{ kind: string }>;
    };
    const recorder = {
      save() {},
      restore() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      closePath() {},
      roundRect() {},
      stroke() {},
      fill() {},
    };
    highlight.render(recorder);
    expect(highlight.layers.map((l) => l.kind)).toEqual(['aabb']);

    panel.setHighlightLayers(['layout', 'clip']);
    highlight.render(recorder);
    expect(highlight.layers.map((l) => l.kind)).toEqual(['layout', 'clip']);
    expect(panel.getHighlightLayers().map((l) => l.kind)).toEqual(['layout', 'clip']);
    // The clip layer resolved to the clipping ancestor, not the target.
    const clip = panel.getHighlightLayers().find((l) => l.kind === 'clip');
    expect(clip?.polygons[0]?.points[2]).toEqual({ x: 200, y: 100 });

    panel.detach();
    host.destroy();
  });

  it('getHighlightLayers is empty when no highlight exists', () => {
    const host = makeHost();
    const panel = attachDevtools(host, { refreshInterval: 0 });
    expect(panel.getHighlightLayers()).toEqual([]);
    panel.detach();
    host.destroy();
  });

  it('setHighlightEnabled(false) removes the host overlay highlight', () => {
    const host = makeHost();
    const target = new Box('h');
    host.add(target);
    const panel = attachDevtools(host, { refreshInterval: 0 });

    panel.select(target);
    expect(host.overlayRootEntity.children.length).toBe(1);
    panel.setHighlightEnabled(false);
    expect(host.overlayRootEntity.children.length).toBe(0);

    panel.detach();
    host.destroy();
  });

  it('setDockSide flips the container edge and border radius', () => {
    const host = makeHost();
    const panel = attachDevtools(host, { refreshInterval: 0, dockSide: 'right' });
    const dock = document.querySelector('[data-vecto-devtools]') as HTMLElement;
    expect(dock.style.right).toBe('0px');

    panel.setDockSide('left');
    expect(dock.style.left).toBe('0px');
    expect(dock.style.right).toBe('');
    expect(dock.style.borderRadius).toBe('0 14px 14px 0');

    panel.detach();
    host.destroy();
  });

  it('reflows on window resize so the perf strip stays within the viewport', () => {
    const host = makeHost();
    const panel = attachDevtools(host, { refreshInterval: 0, showPerf: true });

    // Shrink the viewport (browser chrome / zoom / smaller window) and fire resize.
    (window as unknown as { innerHeight: number }).innerHeight = 500;
    window.dispatchEvent(new Event('resize'));

    const panelScene = (panel as any).panelScene as { height: number };
    expect(panelScene.height).toBe(500);

    // The perf card's bottom edge must sit within the new viewport height.
    const perfCard = (panel as any).perfCard as { y: number; height: number };
    expect(perfCard.y + perfCard.height).toBeLessThanOrEqual(500);

    // Every perf line is above the fold too.
    for (const line of (panel as any).perfLines as Array<{ y: number }>) {
      expect(line.y).toBeLessThan(500);
    }

    panel.detach();
    host.destroy();
    (window as unknown as { innerHeight: number }).innerHeight = 768;
  });

  it('setRefreshInterval restarts the auto-refresh timer', () => {
    vi.useFakeTimers();
    const host = makeHost();
    const panel = attachDevtools(host, { refreshInterval: 0 });
    panel.setRefreshInterval(100);
    host.add(new Box('late'));
    vi.advanceTimersByTime(150);
    expect((panel as any).index.get('late')).toBeDefined();
    panel.detach();
    host.destroy();
    vi.useRealTimers();
  });
});

describe('A11y tab', () => {
  it('renders the selected entity readout and the scene audit', () => {
    const host = makeHost();
    // Focusable with no accessible name: the defect class #212 found.
    const nameless = new Button('', { width: 80, height: 24 });
    nameless.interactive = true;
    host.add(nameless);

    const panel = attachDevtools(host, { refreshInterval: 0, defaultTab: 'tree' });
    panel.select(nameless);

    const rows = ((panel as any).a11yLines as Array<{ text: string }>).map((l) => l.text);
    const joined = rows.join('\n');
    // The readout, then the scene-wide audit. Audits run over the whole scene
    // because the most useful findings are relationships between entities.
    expect(joined).toContain('name');
    expect(joined).toContain('canvas');
    expect(joined).toContain('audit:');

    panel.detach();
    host.destroy();
  });

  it('marks a finding that belongs to the selected entity', () => {
    const host = makeHost();
    const a = new Button('Delete', { width: 60, height: 24 });
    const b = new Button('Delete', { width: 60, height: 24 });
    b.setPosition(0, 40);
    host.add(a);
    host.add(b);

    const panel = attachDevtools(host, { refreshInterval: 0, defaultTab: 'tree' });
    panel.select(b);

    const rows = ((panel as any).a11yLines as Array<{ text: string }>).map((l) => l.text);
    // Duplicate names are reported against the second onward, so selecting `b`
    // should show a marked row.
    expect(rows.some((r) => r.startsWith('▸') && r.includes('duplicate-label'))).toBe(true);

    panel.detach();
    host.destroy();
  });

  it('exposes an a11y tab id', () => {
    const host = makeHost();
    const panel = attachDevtools(host, { refreshInterval: 0, defaultTab: 'a11y' });
    expect((panel as any).tabs.value).toBe('a11y');
    panel.detach();
    host.destroy();
  });
});

describe('incremental tree sync', () => {
  it('skips the tree walk when the shape has not changed', () => {
    const host = makeHost();
    host.add(new Box('a'));
    const panel = attachDevtools(host, { refreshInterval: 0, defaultTab: 'tree' });

    const before = ((panel as any).allNodes as unknown[]).length;
    const model = (panel as any).allNodes;
    panel.refresh();
    // Same array instance: no rebuild happened. The panel used to walk both trees
    // every 500ms regardless, a constant cost proportional to entity count.
    expect((panel as any).allNodes).toBe(model);
    expect(((panel as any).allNodes as unknown[]).length).toBe(before);

    panel.detach();
    host.destroy();
  });

  it('rebuilds when an entity is added', () => {
    const host = makeHost();
    host.add(new Box('a'));
    const panel = attachDevtools(host, { refreshInterval: 0, defaultTab: 'tree' });
    const before = ((panel as any).allNodes as unknown[]).length;

    host.add(new Box('b'));
    panel.refresh();

    expect(((panel as any).allNodes as unknown[]).length).toBeGreaterThan(before);
    panel.detach();
    host.destroy();
  });

  it('rebuilds when an entity is removed', () => {
    const host = makeHost();
    const doomed = new Box('doomed');
    host.add(new Box('a'));
    host.add(doomed);
    const panel = attachDevtools(host, { refreshInterval: 0, defaultTab: 'tree' });
    const before = ((panel as any).allNodes as unknown[]).length;

    host.remove(doomed);
    panel.refresh();

    expect(((panel as any).allNodes as unknown[]).length).toBeLessThan(before);
    panel.detach();
    host.destroy();
  });

  it('rebuilds on an explicit forced refresh even with no shape change', () => {
    const host = makeHost();
    host.add(new Box('a'));
    const panel = attachDevtools(host, { refreshInterval: 0, defaultTab: 'tree' });
    const model = (panel as any).allNodes;

    panel.refresh(true);

    // The periodic reconcile relies on this: the version check trusts that every
    // shape change bumps the counter, and a forced rebuild bounds how long a
    // missed bump can leave the panel stale.
    expect((panel as any).allNodes).not.toBe(model);
    panel.detach();
    host.destroy();
  });

  it('still refreshes selection details when the tree walk is skipped', () => {
    const host = makeHost();
    const target = new Box('sel', 40, 20);
    host.add(target);
    const panel = attachDevtools(host, { refreshInterval: 0, defaultTab: 'tree' });
    panel.select(target);

    target.setPosition(77, 88);
    panel.refresh();

    // Properties change without the shape changing, and a stale readout is the
    // whole reason to be looking at the panel.
    const lines = ((panel as any).detailLines as Array<{ text: string }>).map((l) => l.text);
    expect(lines.join('\n')).toContain('77');
    expect(lines.join('\n')).toContain('88');

    panel.detach();
    host.destroy();
  });
});

describe('parent-owned property edits', () => {
  it('warns after editing a property the parent will overwrite', () => {
    const host = makeHost();
    const stack = new Stack({ direction: 'vertical' });
    const child = new Box('child');
    stack.add(child);
    host.add(stack);

    const panel = attachDevtools(host, { refreshInterval: 0, defaultTab: 'inspect' });
    panel.select(child);
    // The edit is applied rather than refused: nudging a Stack child to see what
    // moves is legitimate, and the useful behaviour is to let it happen and
    // explain why it did not stick.
    (panel as any).applyEdit('x', '123');

    const lines = ((panel as any).detailLines as Array<{ text: string }>).map((l) => l.text);
    expect(lines.join('\n')).toContain('owned by Stack');
    expect(lines.join('\n')).toContain('reverts on the next layout');

    panel.detach();
    host.destroy();
  });

  it('does not warn for a property no parent controls', () => {
    const host = makeHost();
    const free = new Box('free');
    host.add(free);
    const panel = attachDevtools(host, { refreshInterval: 0, defaultTab: 'inspect' });
    panel.select(free);
    (panel as any).applyEdit('x', '55');

    const lines = ((panel as any).detailLines as Array<{ text: string }>).map((l) => l.text);
    expect(lines.join('\n')).not.toContain('reverts on the next layout');

    panel.detach();
    host.destroy();
  });

  it('clears the warning when the selection changes', () => {
    const host = makeHost();
    const stack = new Stack({ direction: 'vertical' });
    const child = new Box('child');
    stack.add(child);
    const other = new Box('other');
    host.add(stack);
    host.add(other);

    const panel = attachDevtools(host, { refreshInterval: 0, defaultTab: 'inspect' });
    panel.select(child);
    (panel as any).applyEdit('x', '123');
    panel.select(other);

    // The warning refers to one edit on one entity, not a persistent state.
    const lines = ((panel as any).detailLines as Array<{ text: string }>).map((l) => l.text);
    expect(lines.join('\n')).not.toContain('reverts on the next layout');

    panel.detach();
    host.destroy();
  });
});
