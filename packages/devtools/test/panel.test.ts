import { describe, it, expect, vi } from 'vitest';
import { Entity, Scene } from '@vectojs/core';
import { Button } from '@vectojs/ui';
import { attachDevtools } from '../src/index';

class Box extends Entity {
  constructor(id: string, w = 40, h = 20) {
    super(id);
    this.width = w;
    this.height = h;
  }
  isPointInside(): boolean {
    return false;
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
