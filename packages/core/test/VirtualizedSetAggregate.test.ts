// @vitest-environment jsdom
/**
 * `VirtualizedSetAggregate` (RFC3 §4.4, CTX-0599): aggregate semantics for
 * virtualized sets — one persistent container (role + aria-label with the
 * count) + roving focus + a small hotspot pool, after the `Tree`/`Table`
 * hotspot precedent (`packages/ui/src/Tree.ts:98-113`).
 *
 * The invariant under test: O(viewport) DOM nodes for an arbitrarily large
 * dataset, with the container always stating the true total and each hotspot
 * stating its position within the FULL set (never the pool position).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Scene, VirtualizedSetAggregate, type VirtualizedSetItem } from '../src';

function fakeCtx(): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'measureText') return (t: string) => ({ width: t.length * 8 });
        if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
        if (prop === 'canvas') return { width: 0, height: 0, style: {} };
        return () => {};
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
}

const items = (n: number): VirtualizedSetItem[] =>
  Array.from({ length: n }, (_, i) => ({ id: `msg-${i}`, label: `Message ${i}` }));

function makeAggregate(
  list: VirtualizedSetItem[],
  opts: ConstructorParameters<typeof VirtualizedSetAggregate>[0] = {},
) {
  return new VirtualizedSetAggregate({
    items: list,
    label: 'Messages',
    width: 200,
    height: 300,
    rowHeight: 30,
    visibleCapacity: 5,
    ...opts,
  });
}

function listitems(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('[role="listitem"]')) as HTMLElement[];
}

describe('VirtualizedSetAggregate', () => {
  let canvas: HTMLCanvasElement;
  let scene: Scene;

  const tick = (): void => {
    (scene as unknown as { isRunning: boolean }).isRunning = true;
    (scene as unknown as { loop: (t: number) => void }).loop(0);
  };

  beforeEach(() => {
    const ctx = fakeCtx();
    HTMLCanvasElement.prototype.getContext = (() => ctx) as never;
    canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    document.body.appendChild(canvas);
    scene = new Scene(canvas, { maxFPS: 0 });
    scene.renderMode = 'always';
  });

  afterEach(() => {
    scene.destroy();
    canvas.remove();
  });

  it('projects one persistent container stating role and the full count', () => {
    const agg = makeAggregate(items(10000));
    scene.add(agg);
    tick();
    const el = scene.getA11yElement(agg.id);
    expect(el).toBeTruthy();
    expect(el!.getAttribute('role')).toBe('list');
    expect(el!.getAttribute('aria-label')).toBe('Messages, 10000 items');
  });

  it('bounds the pool by the viewport, never by the item count', () => {
    const agg = makeAggregate(items(10000));
    scene.add(agg);
    tick();
    expect(agg.poolSize).toBe(5);
    const container = scene.getA11yElement(agg.id)!;
    expect(listitems(container)).toHaveLength(5);
    // One container plus five hotspots, not one node per item.
    const elements = scene as unknown as { a11yElements: Map<string, HTMLElement> };
    expect(elements.a11yElements.size).toBe(6);
  });

  it('hotspots state their position within the full set, not the pool', () => {
    const agg = makeAggregate(items(10000));
    scene.add(agg);
    agg.setVisibleStart(40);
    tick();
    const container = scene.getA11yElement(agg.id)!;
    const visible = listitems(container);
    expect(visible).toHaveLength(5);
    expect(visible[0].getAttribute('aria-label')).toBe('Message 40');
    expect(visible[0].getAttribute('aria-posinset')).toBe('41');
    expect(visible[0].getAttribute('aria-setsize')).toBe('10000');
    expect(visible[4].getAttribute('aria-posinset')).toBe('45');
  });

  it('hotspots stay out of the pointer path, like the Tree/Table precedent', () => {
    const agg = makeAggregate(items(10));
    scene.add(agg);
    tick();
    const container = scene.getA11yElement(agg.id)!;
    expect(container.style.pointerEvents).toBe('none');
    for (const item of listitems(container)) {
      expect(item.style.pointerEvents).toBe('none');
    }
  });

  it('roves the tab stop: only the active item is reachable by Tab', () => {
    const agg = makeAggregate(items(10));
    scene.add(agg);
    tick();
    const container = scene.getA11yElement(agg.id)!;
    const visible = listitems(container);
    expect(visible[0].getAttribute('tabindex')).toBe('0');
    expect(visible.slice(1).map((el) => el.getAttribute('tabindex'))).toEqual([
      '-1',
      '-1',
      '-1',
      '-1',
    ]);
    agg.activateItem('msg-2');
    tick();
    const moved = listitems(scene.getA11yElement(agg.id)!);
    expect(moved[2].getAttribute('tabindex')).toBe('0');
    expect(moved[0].getAttribute('tabindex')).toBe('-1');
  });

  it('moves the active item with arrows and focuses it as it moves', () => {
    const agg = makeAggregate(items(10));
    scene.add(agg);
    tick();
    const key = (key: string) => new KeyboardEvent('keydown', { key });
    agg.handleItemKey(key('ArrowDown'), 'msg-0');
    tick();
    expect(agg.isTabStop('msg-1')).toBe(true);
    const container = scene.getA11yElement(agg.id)!;
    const focused = listitems(container)[1];
    expect(focused.getAttribute('aria-label')).toBe('Message 1');
    expect(document.activeElement).toBe(focused);
    agg.handleItemKey(key('ArrowUp'), 'msg-1');
    tick();
    expect(agg.isTabStop('msg-0')).toBe(true);
  });

  it('activates on Enter, selecting and notifying', () => {
    const activated: Array<{ item: VirtualizedSetItem; index: number }> = [];
    const agg = makeAggregate(items(10), {
      onActivate: (item, index) => activated.push({ item, index }),
    });
    scene.add(agg);
    tick();
    agg.handleItemKey(new KeyboardEvent('keydown', { key: 'Enter' }), 'msg-3');
    tick();
    expect(activated).toEqual([{ item: { id: 'msg-3', label: 'Message 3' }, index: 3 }]);
    const container = scene.getA11yElement(agg.id)!;
    expect(listitems(container)[3].getAttribute('aria-selected')).toBe('true');
  });

  it('scrolls the pool window so keyboard movement stays bound', () => {
    const agg = makeAggregate(items(10));
    scene.add(agg);
    tick();
    agg.handleItemKey(new KeyboardEvent('keydown', { key: 'End' }), 'msg-0');
    tick();
    expect(agg.isTabStop('msg-9')).toBe(true);
    expect(agg.visibleStart).toBe(5);
    const container = scene.getA11yElement(agg.id)!;
    expect(listitems(container)[0].getAttribute('aria-label')).toBe('Message 5');
    agg.handleItemKey(new KeyboardEvent('keydown', { key: 'Home' }), 'msg-9');
    tick();
    expect(agg.visibleStart).toBe(0);
    expect(listitems(scene.getA11yElement(agg.id)!)[0].getAttribute('aria-label')).toBe(
      'Message 0',
    );
  });

  it('updates the count and shrinks the pool when the set changes', () => {
    const agg = makeAggregate(items(10000));
    scene.add(agg);
    tick();
    agg.setItems(items(2));
    tick();
    expect(scene.getA11yElement(agg.id)!.getAttribute('aria-label')).toBe('Messages, 2 items');
    expect(agg.poolSize).toBe(2);
    expect(listitems(scene.getA11yElement(agg.id)!)).toHaveLength(2);
  });

  it('keeps the persistent container projected for an empty set', () => {
    const agg = makeAggregate(items(3));
    scene.add(agg);
    tick();
    agg.setItems([]);
    tick();
    expect(agg.poolSize).toBe(0);
    const el = scene.getA11yElement(agg.id);
    expect(el).toBeTruthy();
    expect(el!.getAttribute('aria-label')).toBe('Messages, 0 items');
  });

  it('ignores unknown ids instead of corrupting roving state', () => {
    const agg = makeAggregate(items(3));
    scene.add(agg);
    tick();
    agg.activateItem('absent');
    agg.handleItemKey(new KeyboardEvent('keydown', { key: 'ArrowDown' }), 'absent');
    tick();
    expect(agg.isTabStop('msg-0')).toBe(true);
  });
});
