// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Entity } from '@vectojs/core';
import { ScrollView } from '../src/ScrollView';
import { Table } from '../src/Table';
import { TreeView } from '../src/Tree';
import { VirtualList } from '../src/VirtualList';
import { Tabs } from '../src/Tabs';

/**
 * These tests drive the REAL wheel handlers in each scroll widget.
 *
 * The previous version of this file re-implemented the three-line deltaMode
 * conversion inside the test and asserted against that local copy, so it passed
 * regardless of what the widgets actually did — it could not have failed if a
 * widget forgot the conversion entirely. Every assertion below reads scroll
 * state out of a real component after a real `emit('wheel', …)`.
 *
 * DOM_DELTA_LINE (1) is scaled by 16px per line; DOM_DELTA_PAGE (2) by the
 * viewport dimension. Pixel mode (0, and an absent deltaMode) passes through.
 */

/** A fixed-size leaf so a container has measurable content. */
class Box extends Entity {
  constructor(w: number, h: number) {
    super();
    this.width = w;
    this.height = h;
  }
  public override isPointInside(): boolean {
    return false;
  }
  public override render(): void {}
}

/** A wheel-event stand-in. `deltaMode` omitted means "pixel mode" to the handler. */
function wheel(deltaY: number, deltaMode?: number): Record<string, unknown> {
  return {
    deltaY,
    ...(deltaMode === undefined ? {} : { deltaMode }),
    preventDefault() {},
  };
}

/** Settle ScrollView's spring: its content is a child node ticked by the tree walk. */
function settle(sv: ScrollView): void {
  for (let i = 0; i < 600; i++) {
    sv.update(16, i * 16);
    sv.content.update(16, i * 16);
  }
}

/** Read a widget's private scroll target. */
const targetOf = (w: unknown, field: string): number =>
  (w as unknown as Record<string, number>)[field];

describe('wheel deltaMode conversion in real widgets', () => {
  describe('ScrollView', () => {
    const make = () => {
      const sv = new ScrollView({ width: 200, height: 100 });
      sv.add(new Box(50, 3000)); // maxScroll = 2900
      return sv;
    };

    it('treats a pixel-mode delta as pixels', () => {
      const sv = make();
      sv.emit('wheel', wheel(50, 0));
      settle(sv);
      expect(sv.content.y).toBeCloseTo(-50, 0);
    });

    it('treats an absent deltaMode as pixel mode', () => {
      const sv = make();
      sv.emit('wheel', wheel(50));
      settle(sv);
      expect(sv.content.y).toBeCloseTo(-50, 0);
    });

    it('scales a line-mode delta by 16px per line', () => {
      const sv = make();
      sv.emit('wheel', wheel(3, 1)); // 3 lines → 48px
      settle(sv);
      expect(sv.content.y).toBeCloseTo(-48, 0);
    });

    it('scales a page-mode delta by the viewport height', () => {
      const sv = make();
      sv.emit('wheel', wheel(1, 2)); // 1 page → 100px (its height)
      settle(sv);
      expect(sv.content.y).toBeCloseTo(-100, 0);
    });

    it('scrolls a line-mode notch materially further than the raw delta', () => {
      // The defect this conversion fixes: a 3-line notch moved 3px, not 48px.
      const raw = make();
      raw.emit('wheel', wheel(3, 0));
      settle(raw);
      const lines = make();
      lines.emit('wheel', wheel(3, 1));
      settle(lines);
      expect(Math.abs(lines.content.y)).toBeGreaterThan(Math.abs(raw.content.y) * 10);
    });
  });

  describe('VirtualList', () => {
    const make = () =>
      new VirtualList<string>({
        items: Array.from({ length: 500 }, (_, i) => `item-${i}`),
        renderItem: () => new Box(100, 20),
        estimatedRowHeight: 20,
        width: 100,
        height: 200,
        overscan: 0,
      });

    it('treats a pixel-mode delta as pixels', () => {
      const list = make();
      list.emit('wheel', wheel(50, 0));
      expect(targetOf(list, '_targetY')).toBeCloseTo(50);
    });

    it('scales a line-mode delta by 16px per line', () => {
      const list = make();
      list.emit('wheel', wheel(3, 1));
      expect(targetOf(list, '_targetY')).toBeCloseTo(48);
    });

    it('scales a page-mode delta by the viewport height', () => {
      const list = make();
      list.emit('wheel', wheel(1, 2));
      expect(targetOf(list, '_targetY')).toBeCloseTo(200);
    });

    it('marks the scene dirty so an onDemand scene repaints', () => {
      // Regression: the deltaMode change dropped this markDirty(). Scene.loop()
      // decides idleness from `frameHadAnimation`, which is only refreshed on a
      // RENDERED frame — an onDemand scene skips the frame outright, so without
      // a markDirty() here the first post-wheel frame never runs and the scroll
      // does not start. Every other path that moves _targetY marks dirty.
      const list = make();
      const markDirty = vi.fn();
      (list as unknown as { _scene: unknown })._scene = { markDirty };

      list.emit('wheel', wheel(50, 0));
      expect(markDirty).toHaveBeenCalled();
    });

    it('marks the scene dirty on a pointer drag too (unchanged path)', () => {
      const list = make();
      const markDirty = vi.fn();
      (list as unknown as { _scene: unknown })._scene = { markDirty };

      list.emit('pointerdown', { localY: 100 });
      list.emit('pointermove', { localY: 50 });
      expect(markDirty).toHaveBeenCalled();
    });
  });

  describe('Table', () => {
    const make = () =>
      new Table({
        headers: ['A', 'B'],
        rows: Array.from({ length: 500 }, (_, i) => [`a${i}`, `b${i}`]),
        width: 300,
        rowHeight: 30,
        viewportHeight: 300,
      });

    it('treats a pixel-mode delta as pixels', () => {
      const t = make();
      t.emit('wheel', wheel(60, 0));
      expect(targetOf(t, '_targetY')).toBeCloseTo(60);
    });

    it('scales a line-mode delta by 16px per line', () => {
      const t = make();
      t.emit('wheel', wheel(3, 1));
      expect(targetOf(t, '_targetY')).toBeCloseTo(48);
    });

    it('scales a page-mode delta by the viewport height', () => {
      const t = make();
      t.emit('wheel', wheel(1, 2));
      expect(targetOf(t, '_targetY')).toBeCloseTo(t.height);
    });
  });

  describe('TreeView', () => {
    const make = () =>
      new TreeView({
        nodes: Array.from({ length: 300 }, (_, i) => ({
          id: `n${i}`,
          label: `node ${i}`,
        })),
        width: 200,
        height: 200,
        rowHeight: 24,
      });

    it('treats a pixel-mode delta as pixels', () => {
      const tree = make();
      tree.emit('wheel', wheel(50, 0));
      expect(targetOf(tree, '_targetY')).toBeCloseTo(50);
    });

    it('scales a line-mode delta by 16px per line', () => {
      const tree = make();
      tree.emit('wheel', wheel(3, 1));
      expect(targetOf(tree, '_targetY')).toBeCloseTo(48);
    });

    it('scales a page-mode delta by the viewport height', () => {
      const tree = make();
      tree.emit('wheel', wheel(1, 2));
      expect(targetOf(tree, '_targetY')).toBeCloseTo(200);
    });
  });

  describe('Tabs', () => {
    // Enough tabs at the default 160px preferred width to overflow a 300px bar.
    const make = () =>
      new Tabs({
        tabs: Array.from({ length: 20 }, (_, i) => ({
          id: `t${i}`,
          label: `Tab ${i}`,
          content: new Box(10, 10),
        })),
        width: 300,
        height: 200,
      });

    it('treats a pixel-mode delta as pixels', () => {
      const tabs = make();
      tabs.emit('wheel', wheel(40, 0));
      expect(targetOf(tabs, '_scrollX')).toBeCloseTo(40);
    });

    it('scales a line-mode delta by 16px per line', () => {
      const tabs = make();
      tabs.emit('wheel', wheel(2, 1)); // 2 lines → 32px
      expect(targetOf(tabs, '_scrollX')).toBeCloseTo(32);
    });

    it('scales a page-mode vertical delta by the viewport height', () => {
      // Tabs picks the dominant axis AFTER conversion, then applies it to _scrollX.
      const tabs = make();
      tabs.emit('wheel', wheel(1, 2));
      const max = (tabs as unknown as { _maxScroll(): number })._maxScroll();
      expect(targetOf(tabs, '_scrollX')).toBeCloseTo(Math.min(max, tabs.height));
    });
  });
});
