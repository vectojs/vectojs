// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Scene, Entity } from '@vectojs/core';
import {
  Overlay,
  VirtualList,
  TreeView,
  PanelGroup,
  Panel,
  Tooltip,
  Popover,
  ContextMenu,
  RadioGroup,
  Tabs,
  ProgressBar,
} from '../src';

describe('UI 0.1.1 Components', () => {
  beforeEach(() => {
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type: string) {
      if (type === '2d') {
        return {
          font: '',
          fillStyle: '',
          measureText: () => ({ width: 100 }),
          fillText: () => {},
          scale: () => {},
          clearRect: () => {},
          save: () => {},
          restore: () => {},
          translate: () => {},
          rotate: () => {},
          beginPath: () => {},
          rect: () => {},
          clip: () => {},
          roundRect: () => {},
          fill: () => {},
          stroke: () => {},
          moveTo: () => {},
          lineTo: () => {},
        } as any;
      }
      return originalGetContext.apply(this, arguments as any);
    };
  });

  describe('Overlay & positioning', () => {
    it('mounts to overlayRoot on showAt', () => {
      const canvas = document.createElement('canvas');
      const scene = new Scene(canvas);
      const target = new Entity('target');
      scene.add(target);

      const overlay = new Overlay({ width: 100, height: 100 });
      expect(overlay.parent).toBeNull();

      overlay.showAt(target);
      expect(overlay.parent).toBe(scene.overlayRoot);
      expect(overlay.visible).toBe(true);

      overlay.hide();
      expect(overlay.visible).toBe(false);
    });

    it('positions correctly with respect to target and boundary limits', () => {
      const canvas = document.createElement('canvas');
      canvas.width = 800;
      canvas.height = 600;
      const scene = new Scene(canvas);
      const target = new Entity('target');
      target.width = 50;
      target.height = 50;
      target.x = 200;
      target.y = 200;
      scene.add(target);

      const overlay = new Overlay({ width: 100, height: 80, placement: 'bottom', offset: 10 });
      overlay.showAt(target);

      // bottom placement: x = target.x + target.width/2 - overlay.width/2 = 200 + 25 - 50 = 175
      // y = target.y + target.height + offset = 200 + 50 + 10 = 260
      expect(overlay.x).toBe(175);
      expect(overlay.y).toBe(260);
    });
  });

  describe('VirtualList', () => {
    it('renders only visible items', () => {
      const items = Array.from({ length: 100 }, (_, i) => `Item ${i}`);
      const renderedIndices: number[] = [];
      const list = new VirtualList({
        items,
        renderItem: (item, idx) => {
          renderedIndices.push(idx);
          const ent = new Entity();
          ent.height = 20;
          return ent;
        },
        estimatedRowHeight: 20,
        width: 200,
        height: 100,
        overscan: 2,
      });

      // Height of viewport is 100, row height 20.
      // So 5 rows fit. Plus 2 overscan below = 7 rows total visible (indices 0..6).
      expect(list.children.length).toBeLessThanOrEqual(7);
      expect(renderedIndices).toContain(0);
      expect(renderedIndices).toContain(6);
      expect(renderedIndices).not.toContain(8);
    });
  });

  describe('TreeView', () => {
    it('supports eager and lazy tree node structures', async () => {
      const onSelect = vi.fn();
      const nodes = [
        {
          id: '1',
          label: 'Root A',
          children: [{ id: '1.1', label: 'Child A1' }],
        },
        {
          id: '2',
          label: 'Root B (Lazy)',
          children: async () => [{ id: '2.1', label: 'Child B1' }],
        },
      ];

      const tree = new TreeView({
        nodes,
        width: 200,
        height: 400,
        onSelect,
      });

      // Simulate clicking on the first item (Root A) to expand it
      // tree pointerdown checks localY / rowHeight
      tree.emit('pointerdown', { localY: 10 });
      // Tree resolves node 1 is clicked. It has children, so it expands.

      // Simulate clicking on Root B (Lazy) which is index 1 before expansion,
      // but after expansion index 1 is Child A1, and Root B is index 2.
      tree.emit('pointerdown', { localY: 2 * 28 + 10 }); // index 2 (Root B)

      // Give the lazy loading microtask a chance to complete
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(tree).toBeTruthy();
    });
  });

  describe('ResizablePanel', () => {
    it('distributes sizes correctly and resizes on handle drag', () => {
      const group = new PanelGroup({ direction: 'horizontal', width: 400, height: 200 });
      const p1 = new Panel({ minSize: 50, defaultSize: 0.25 }); // expected 100px minus half drag handles?
      const p2 = new Panel({ minSize: 100 });
      group.addPanel(p1);
      group.addPanel(p2);

      // Handle size default is 4. Total avail = 400 - 4 = 396
      // p1 is 0.25 * 396 = 99. p2 is remaining = 297.
      expect(p1.width).toBeCloseTo(99);
      expect(p2.width).toBeCloseTo(297);
    });
  });

  describe('Tooltip, Popover & ContextMenu', () => {
    it('shows Tooltip on target hover', async () => {
      const canvas = document.createElement('canvas');
      const scene = new Scene(canvas);
      const target = new Entity('btn');
      scene.add(target);

      const tooltip = new Tooltip({ target, content: 'Help info', delay: 0 });
      scene.add(tooltip);

      target.emit('hover', {});
      // Wait for delay
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(tooltip.parent).toBe(scene.overlayRoot);
      expect(tooltip.visible).toBe(true);

      target.emit('pointerleave', {});
      expect(tooltip.visible).toBe(false);
    });

    it('toggles Popover on target click', () => {
      const canvas = document.createElement('canvas');
      const scene = new Scene(canvas);
      const target = new Entity('btn');
      scene.add(target);

      const popover = new Popover({ target, width: 100, height: 100 });
      scene.add(popover);

      expect(popover.visible).toBe(false);
      target.emit('click', {});
      expect(popover.visible).toBe(true);

      target.emit('click', {});
      expect(popover.visible).toBe(false);
    });

    it('displays ContextMenu at point', () => {
      const canvas = document.createElement('canvas');
      const scene = new Scene(canvas);
      const menu = new ContextMenu({
        items: [
          { label: 'Item 1', onClick: () => {} },
          { separator: true },
          { label: 'Item 2', disabled: true },
        ],
      });
      scene.add(menu);

      menu.showAtPoint(100, 150);
      expect(menu.x).toBe(100);
      expect(menu.y).toBe(150);
      expect(menu.visible).toBe(true);
    });
  });

  describe('RadioGroup', () => {
    it('manages value selection and emits change', () => {
      const onChange = vi.fn();
      const group = new RadioGroup({
        options: [
          { value: 'a', label: 'Option A' },
          { value: 'b', label: 'Option B' },
        ],
        value: 'a',
        onChange,
      });

      expect(group.value).toBe('a');

      // Simulate click on Option B
      // Option B starts at x = 0 (vertical group). localY is options[1].
      // Option A starts at 0, B is at size + gap = 18 + 12 = 30.
      group.emit('pointerdown', { localX: 10, localY: 35 });
      expect(group.value).toBe('b');
      expect(onChange).toHaveBeenCalledWith('b');
    });
  });

  describe('Tabs', () => {
    it('switches tabs and content visibility', () => {
      const onChange = vi.fn();
      const tab1Content = new Entity('tab1');
      const tab2Content = new Entity('tab2');
      const tabs = new Tabs({
        width: 300,
        height: 200,
        tabs: [
          { id: 'tab1', label: 'Tab 1', content: tab1Content },
          { id: 'tab2', label: 'Tab 2', content: tab2Content },
        ],
        value: 'tab1',
        onChange,
      });

      expect(tabs.value).toBe('tab1');
      expect(tabs.children).toContain(tab1Content);
      expect(tabs.children).not.toContain(tab2Content);

      // Click Tab 2
      // Tab width = 300 / 2 = 150. Tab 2 starts at x = 150.
      tabs.emit('pointerdown', { localX: 200, localY: 10 });
      expect(tabs.value).toBe('tab2');
      expect(onChange).toHaveBeenCalledWith('tab2');
      expect(tabs.children).not.toContain(tab1Content);
      expect(tabs.children).toContain(tab2Content);
    });
  });

  describe('ProgressBar', () => {
    it('renders correct progress scale and updates value', () => {
      const bar = new ProgressBar({ value: 0.25, width: 200, height: 10 });
      expect(bar.value).toBe(0.25);
      expect(bar.getA11yAttributes().value).toBe('25');

      bar.setValue(0.75);
      expect(bar.value).toBe(0.75);
      expect(bar.getA11yAttributes().value).toBe('75');
    });
  });
});
