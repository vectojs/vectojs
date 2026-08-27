// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Scene, Entity } from '@vectojs/core';
import {
  Overlay,
  VirtualList,
  RowHeights,
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
      document.body.appendChild(canvas);
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
      document.body.appendChild(canvas);
      canvas.width = 800;
      canvas.height = 600;
      const scene = new Scene(canvas);
      const target = new Entity('target');
      target.width = 50;
      target.height = 50;
      target.x = 200;
      target.y = 200;
      scene.add(target);

      const overlay = new Overlay({
        width: 100,
        height: 80,
        placement: 'bottom',
        offset: 10,
      });
      overlay.showAt(target);

      // bottom placement: x = target.x + target.width/2 - overlay.width/2 = 200 + 25 - 50 = 175
      // y = target.y + target.height + offset = 200 + 50 + 10 = 260
      expect(overlay.x).toBe(175);
      expect(overlay.y).toBe(260);
    });

    it('anchors to a target world-space box under ancestor transforms', () => {
      const canvas = document.createElement('canvas');
      document.body.appendChild(canvas);
      canvas.width = 800;
      canvas.height = 600;
      const scene = new Scene(canvas);
      const parent = new Entity('parent');
      parent.setPosition(100, 50);
      parent.scaleX = 2;
      const target = new Entity('target');
      target.setPosition(10, 20);
      target.width = 50;
      target.height = 40;
      parent.add(target);
      scene.add(parent);

      const overlay = new Overlay({
        width: 100,
        height: 80,
        placement: 'bottom',
        offset: 10,
      });
      overlay.showAt(target);

      expect(overlay.x).toBe(120);
      expect(overlay.y).toBe(120);
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

    it('renders nothing for an empty item list, instead of calling renderItem(undefined, 0)', () => {
      const renderItem = vi.fn(() => {
        const ent = new Entity();
        ent.height = 20;
        return ent;
      });
      const list = new VirtualList({
        items: [],
        renderItem,
        estimatedRowHeight: 20,
        width: 200,
        height: 100,
      });

      expect(renderItem).not.toHaveBeenCalled();
      expect(list.children.length).toBe(0);
    });

    it('scrolls a long list to an index in the middle using O(log n) row math', () => {
      const items = Array.from({ length: 10000 }, (_, i) => `Item ${i}`);
      const rendered = new Set<number>();
      const list = new VirtualList({
        items,
        renderItem: (_item, idx) => {
          rendered.add(idx);
          const ent = new Entity();
          ent.height = 20;
          return ent;
        },
        estimatedRowHeight: 20,
        width: 200,
        height: 100,
        overscan: 2,
      });
      list.scrollToIndex(5000);
      // Drive the scroll integrator to settle at the target.
      for (let i = 0; i < 200; i++) list.update(16, i * 16);

      // Only a viewport-worth (+overscan) of rows is materialized, and it is
      // the window around index 5000 — not the whole 10k list.
      expect(list.children.length).toBeLessThanOrEqual(10);
      const mounted = [...rendered].filter((i) => i >= 4990 && i <= 5010);
      expect(mounted.length).toBeGreaterThan(0);
    });
  });

  describe('RowHeights (Fenwick prefix-sum)', () => {
    it('answers total/prefix/indexAt over uniform estimates', () => {
      const rh = new RowHeights(10, 20);
      expect(rh.total()).toBe(200);
      expect(rh.prefix(0)).toBe(0);
      expect(rh.prefix(3)).toBe(60);
      expect(rh.prefix(10)).toBe(200);
      expect(rh.indexAt(0)).toBe(0);
      expect(rh.indexAt(19)).toBe(0);
      expect(rh.indexAt(20)).toBe(1); // exactly on the boundary → next row
      expect(rh.indexAt(55)).toBe(2);
      expect(rh.indexAt(100000)).toBe(9); // clamped to last row
    });

    it('applies measured-height deltas and keeps prefix/total consistent', () => {
      const rh = new RowHeights(5, 20);
      rh.set(0, 50); // row 0 taller than estimate
      rh.set(2, 10); // row 2 shorter
      expect(rh.heightOf(0)).toBe(50);
      expect(rh.heightOf(2)).toBe(10);
      expect(rh.total()).toBe(50 + 20 + 10 + 20 + 20);
      expect(rh.prefix(1)).toBe(50);
      expect(rh.prefix(3)).toBe(50 + 20 + 10);
      // indexAt reflects the variable heights.
      expect(rh.indexAt(49)).toBe(0);
      expect(rh.indexAt(50)).toBe(1);
      expect(rh.indexAt(69)).toBe(1);
      expect(rh.indexAt(70)).toBe(2);
    });

    it('matches a brute-force scan for a random height profile', () => {
      const n = 200;
      const rh = new RowHeights(n, 15);
      const heights = Array.from({ length: n }, () => 15);
      // Apply some random measured heights.
      let seed = 42;
      const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 0x100000000);
      for (let k = 0; k < 80; k++) {
        const i = Math.floor(rand() * n);
        const h = 5 + Math.floor(rand() * 40);
        heights[i] = h;
        rh.set(i, h);
      }
      const bruteTotal = heights.reduce((a, b) => a + b, 0);
      expect(rh.total()).toBe(bruteTotal);
      for (const probe of [0, 1, 50, 123, n]) {
        let sum = 0;
        for (let i = 0; i < probe; i++) sum += heights[i];
        expect(rh.prefix(probe)).toBe(sum);
      }
      // indexAt at several offsets equals the brute-force containing row.
      for (const y of [0, 30, 500, 1200, bruteTotal - 1]) {
        let acc = 0;
        let expected = n - 1;
        for (let i = 0; i < n; i++) {
          if (acc + heights[i] > y) {
            expected = i;
            break;
          }
          acc += heights[i];
        }
        expect(rh.indexAt(y)).toBe(Math.min(expected, n - 1));
      }
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

      // Simulate tapping the first item (Root A) to expand it. A tap is a
      // pointerdown+pointerup at the same spot (toggle fires on pointerup so a
      // touch drag-scroll doesn't accidentally toggle).
      tree.emit('pointerdown', { localY: 10 });
      tree.emit('pointerup', { localY: 10 });
      // Tree resolves node 1 is clicked. It has children, so it expands.

      // Simulate tapping Root B (Lazy) which is index 1 before expansion,
      // but after expansion index 1 is Child A1, and Root B is index 2.
      tree.emit('pointerdown', { localY: 2 * 28 + 10 }); // index 2 (Root B)
      tree.emit('pointerup', { localY: 2 * 28 + 10 });

      // Give the lazy loading microtask a chance to complete
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(tree).toBeTruthy();
    });

    it("keeps a lazy node's loading indicator up while a sibling lazy load resolves and rebuilds the rows", async () => {
      let resolveA: (children: any[]) => void = () => {};
      let resolveB: (children: any[]) => void = () => {};
      const nodes = [
        {
          id: 'a',
          label: 'A (lazy)',
          children: () => new Promise<any[]>((resolve) => (resolveA = resolve)),
        },
        {
          id: 'b',
          label: 'B (lazy)',
          children: () => new Promise<any[]>((resolve) => (resolveB = resolve)),
        },
      ];
      const tree = new TreeView({ nodes, width: 200, height: 400 });

      // Expand both lazy nodes before either resolves (tap = down+up).
      tree.emit('pointerdown', { localY: 10 }); // row 0: A
      tree.emit('pointerup', { localY: 10 });
      tree.emit('pointerdown', { localY: 28 + 10 }); // row 1: B
      tree.emit('pointerup', { localY: 28 + 10 });
      await Promise.resolve(); // let both `_toggle` calls reach their `await`

      const rowsAfterBothPending = (tree as any)._rows as Array<{
        node: { id: string };
        loading: boolean;
      }>;
      expect(rowsAfterBothPending.find((r) => r.node.id === 'a')?.loading).toBe(true);
      expect(rowsAfterBothPending.find((r) => r.node.id === 'b')?.loading).toBe(true);

      // A resolves first, rebuilding `_rows` — B's row must still show loading.
      resolveA([{ id: 'a.1', label: 'Child A1' }]);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const rowsAfterAResolves = (tree as any)._rows as Array<{
        node: { id: string };
        loading: boolean;
      }>;
      expect(rowsAfterAResolves.find((r) => r.node.id === 'b')?.loading).toBe(true);

      // B resolves too — its loading indicator must clear.
      resolveB([{ id: 'b.1', label: 'Child B1' }]);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const rowsAfterBResolves = (tree as any)._rows as Array<{
        node: { id: string };
        loading: boolean;
      }>;
      expect(rowsAfterBResolves.find((r) => r.node.id === 'b')?.loading).toBe(false);
    });

    it('drag-scrolls on touch and does not toggle the row it started on', () => {
      const onSelect = vi.fn();
      // 50 flat rows, tall enough to overflow the 400px viewport.
      const nodes = Array.from({ length: 50 }, (_, i) => ({
        id: `n${i}`,
        label: `Node ${i}`,
      }));
      const tree = new TreeView({
        nodes,
        width: 200,
        height: 400,
        rowHeight: 28,
        onSelect,
      });
      const expandedBefore = (tree as any)._rows.length;

      // Press on row 0 and drag UP 200px → scrolls down, no toggle.
      tree.emit('pointerdown', { localY: 10 });
      tree.emit('pointermove', { localY: 120 });
      tree.emit('pointermove', { localY: 10 - 200 + 120 }); // net −200 from down
      tree.emit('pointerup', { localY: 10 - 200 + 120 });
      for (let i = 0; i < 300; i++) tree.update(16, i * 16);

      expect((tree as any)._targetY).toBeGreaterThan(0); // scrolled
      // Flat nodes have no children, so a toggle wouldn't change row count, but
      // onSelect must NOT fire for a drag.
      expect(onSelect).not.toHaveBeenCalled();
      expect((tree as any)._rows.length).toBe(expandedBefore);
    });

    it('treats a tap (down+up, no movement) as a toggle, not a scroll', () => {
      const nodes = [
        {
          id: 'root',
          label: 'Root',
          children: [{ id: 'child', label: 'Child' }],
        },
      ];
      const tree = new TreeView({
        nodes,
        width: 200,
        height: 400,
        rowHeight: 28,
      });
      expect((tree as any)._rows.length).toBe(1); // collapsed

      // Tap row 0 → expands (toggle fires on pointerup).
      tree.emit('pointerdown', { localY: 10 });
      tree.emit('pointerup', { localY: 10 });

      expect((tree as any)._rows.length).toBe(2); // Root + Child
      // Scroll target untouched by a tap.
      expect((tree as any)._targetY).toBe(0);
    });

    describe('a11y: role=treeitem + keyboard (E-4b)', () => {
      const hotspots = (tree: TreeView) =>
        tree.children.filter((c) => (c as any).getA11yAttributes?.().role === 'treeitem');

      it('projects one role=treeitem hotspot per visible row with level/expanded/selected + roving tabindex', () => {
        const tree = new TreeView({
          nodes: [
            { id: 'a', label: 'A', children: [{ id: 'a1', label: 'A1' }] },
            { id: 'b', label: 'B' },
          ],
          width: 200,
          height: 400,
          rowHeight: 28,
        });
        tree.update(16, 16); // sync hotspots

        const attrs = hotspots(tree).map((h) => (h as any).getA11yAttributes());
        // Two top-level rows (A expandable, B leaf).
        expect(attrs).toHaveLength(2);
        expect(attrs[0]).toMatchObject({
          role: 'treeitem',
          label: 'A',
          level: 1,
          expanded: false,
        });
        expect(attrs[1]).toMatchObject({
          role: 'treeitem',
          label: 'B',
          level: 1,
        });
        // Leaf B has no aria-expanded.
        expect(attrs[1].expanded).toBeUndefined();
        // Roving tabindex: exactly one tab stop (the first row by default).
        expect(attrs.filter((a) => a.tabIndex === 0)).toHaveLength(1);
        expect(attrs[0].tabIndex).toBe(0);
      });

      it('ArrowRight expands a collapsed parent, ArrowLeft collapses it', () => {
        const tree = new TreeView({
          nodes: [{ id: 'a', label: 'A', children: [{ id: 'a1', label: 'A1' }] }],
          width: 200,
          height: 400,
          rowHeight: 28,
        });
        tree.update(16, 16);
        expect((tree as any)._rows.length).toBe(1);

        tree.handleTreeKey({ key: 'ArrowRight', preventDefault() {} } as any, 'a');
        expect((tree as any)._rows.length).toBe(2); // A + A1 revealed
        expect((tree as any)._expanded.has('a')).toBe(true);

        tree.handleTreeKey({ key: 'ArrowLeft', preventDefault() {} } as any, 'a');
        expect((tree as any)._expanded.has('a')).toBe(false);
      });

      it('ArrowDown/ArrowUp move the active row; Enter selects a leaf', () => {
        const onSelect = vi.fn();
        const tree = new TreeView({
          nodes: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
            { id: 'c', label: 'C' },
          ],
          width: 200,
          height: 400,
          rowHeight: 28,
          onSelect,
        });
        tree.update(16, 16);

        tree.handleTreeKey({ key: 'ArrowDown', preventDefault() {} } as any, 'a');
        expect((tree as any)._activeId).toBe('b');
        tree.handleTreeKey({ key: 'End', preventDefault() {} } as any, 'b');
        expect((tree as any)._activeId).toBe('c');
        tree.handleTreeKey({ key: 'ArrowUp', preventDefault() {} } as any, 'c');
        expect((tree as any)._activeId).toBe('b');

        tree.handleTreeKey({ key: 'Enter', preventDefault() {} } as any, 'b');
        expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
      });
    });
  });

  describe('ResizablePanel', () => {
    it('distributes sizes correctly and resizes on handle drag', () => {
      const group = new PanelGroup({
        direction: 'horizontal',
        width: 400,
        height: 200,
      });
      const p1 = new Panel({ minSize: 50, defaultSize: 0.25 }); // expected 100px minus half drag handles?
      const p2 = new Panel({ minSize: 100 });
      group.addPanel(p1);
      group.addPanel(p2);

      // Handle size default is 4. Total avail = 400 - 4 = 396
      // p1 is 0.25 * 396 = 99. p2 is remaining = 297.
      expect(p1.width).toBeCloseTo(99);
      expect(p2.width).toBeCloseTo(297);
    });

    it('keeps panel sizes inside the group after container resize', () => {
      const group = new PanelGroup({
        direction: 'horizontal',
        width: 540,
        height: 220,
      });
      const p1 = new Panel({ minSize: 130, defaultSize: 0.36 });
      const p2 = new Panel({ minSize: 180 });
      group.addPanel(p1).addPanel(p2);

      group.resize(360, 220);

      expect(p1.width + p2.width).toBeCloseTo(356);
      expect(p1.width).toBeGreaterThanOrEqual(130);
      expect(p2.width).toBeGreaterThanOrEqual(180);
      expect(p2.x + p2.width).toBeCloseTo(360);
    });

    it('tracks the cursor 1:1 in scene space as the handle moves under it', () => {
      const group = new PanelGroup({
        direction: 'horizontal',
        width: 400,
        height: 200,
      });
      const p1 = new Panel({ minSize: 50, defaultSize: 0.25 });
      const p2 = new Panel({ minSize: 50 });
      group.addPanel(p1).addPanel(p2);

      const handle = (group as unknown as { _handles: Entity[] })._handles[0];
      const startWidth = p1.width; // ~99

      // Press on the handle, then move the pointer 60px right in SCENE space.
      // The handle slides right with the growing panel, so its LOCAL x barely
      // changes; only scene coordinates track the true cursor travel.
      handle.emit('pointerdown', { sceneX: handle.x, sceneY: 100 });
      handle.emit('pointermove', { sceneX: handle.x + 60, sceneY: 100 });

      expect(p1.width - startWidth).toBeCloseTo(60, 0);
    });

    it('does not abort a drag when the pointer briefly leaves the thin handle', () => {
      const group = new PanelGroup({
        direction: 'horizontal',
        width: 400,
        height: 200,
      });
      const p1 = new Panel({ minSize: 50, defaultSize: 0.25 });
      const p2 = new Panel({ minSize: 50 });
      group.addPanel(p1).addPanel(p2);

      const handle = (group as unknown as { _handles: Entity[] })._handles[0];
      const startWidth = p1.width;

      handle.emit('pointerdown', { sceneX: handle.x, sceneY: 100 });
      handle.emit('pointerleave', {}); // fast drag outruns the 4px handle
      handle.emit('pointermove', { sceneX: handle.x + 40, sceneY: 100 });

      // Drag survived the leave — still resizing.
      expect(p1.width).toBeGreaterThan(startWidth);
    });
  });

  describe('Tooltip, Popover & ContextMenu', () => {
    it('shows Tooltip on target hover', async () => {
      const canvas = document.createElement('canvas');
      document.body.appendChild(canvas);
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

    it('detaches its target listeners on destroy, instead of leaking a reference to itself', async () => {
      const canvas = document.createElement('canvas');
      document.body.appendChild(canvas);
      const scene = new Scene(canvas);
      const target = new Entity('btn');
      scene.add(target);

      const tooltip = new Tooltip({ target, content: 'Help info', delay: 0 });
      scene.add(tooltip);
      tooltip.destroy();

      // A destroyed tooltip must not be resurrected into the tree by an event
      // its (still-alive) target keeps emitting.
      target.emit('hover', {});
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(tooltip.parent).toBeNull();
    });

    it('toggles Popover on target click', () => {
      const canvas = document.createElement('canvas');
      document.body.appendChild(canvas);
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

    it('detaches its target click listener on destroy, instead of leaking a reference to itself', () => {
      const canvas = document.createElement('canvas');
      document.body.appendChild(canvas);
      const scene = new Scene(canvas);
      const target = new Entity('btn');
      scene.add(target);

      const popover = new Popover({ target, width: 100, height: 100 });
      scene.add(popover);
      popover.destroy();

      // A destroyed popover must not be resurrected into the tree by a click
      // its (still-alive) target keeps emitting.
      target.emit('click', {});
      expect(popover.parent).toBeNull();
    });

    it('displays ContextMenu at point', () => {
      const canvas = document.createElement('canvas');
      document.body.appendChild(canvas);
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

    it('shows the correct submenu content when a different submenu item is opened', () => {
      const canvas = document.createElement('canvas');
      document.body.appendChild(canvas);
      const scene = new Scene(canvas);
      const menu = new ContextMenu({
        items: [
          { label: 'Alpha', children: [{ label: 'Alpha child' }] },
          { label: 'Beta', children: [{ label: 'Beta child' }] },
        ],
        itemHeight: 32,
      });
      scene.add(menu);
      menu.showAtPoint(0, 0);

      // Open the first item's submenu (row 0).
      menu.emit('pointerdown', { localY: 10 });
      const firstSubmenu = (menu as any)._submenu;
      expect(firstSubmenu.items?.[0]?.label ?? (firstSubmenu as any)._items[0].label).toBe(
        'Alpha child',
      );

      // Open the second item's submenu (row 1) — must show Beta's children,
      // not silently reposition the still-showing Alpha submenu.
      menu.emit('pointerdown', { localY: 42 });
      const secondSubmenu = (menu as any)._submenu;
      expect((secondSubmenu as any)._items[0].label).toBe('Beta child');
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

    it('projects a role=radio hotspot per option with aria-checked + roving tabindex', () => {
      const group = new RadioGroup({
        options: [
          { value: 'a', label: 'Option A' },
          { value: 'b', label: 'Option B' },
          { value: 'c', label: 'Option C', disabled: true },
        ],
        value: 'a',
      });
      const spots = group.children.filter((c) => (c as any).getA11yAttributes?.().role === 'radio');
      expect(spots).toHaveLength(3);
      const attrs = spots.map((s) => (s as any).getA11yAttributes());
      expect(attrs[0]).toMatchObject({
        role: 'radio',
        checked: true,
        tabIndex: 0,
      });
      expect(attrs[1]).toMatchObject({
        role: 'radio',
        checked: false,
        tabIndex: -1,
      });
      expect(attrs[2]).toMatchObject({ role: 'radio', disabled: true });
    });

    it('arrow keys move + select within the group, skipping disabled and wrapping', () => {
      const onChange = vi.fn();
      const group = new RadioGroup({
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B', disabled: true },
          { value: 'c', label: 'C' },
        ],
        value: 'a',
        onChange,
      });
      // From 'a', ArrowDown skips disabled 'b' → 'c'.
      group.handleRadioKey({ key: 'ArrowDown', preventDefault() {} } as any, 'a');
      expect(group.value).toBe('c');
      // From 'c', ArrowDown wraps to 'a'.
      group.handleRadioKey({ key: 'ArrowDown', preventDefault() {} } as any, 'c');
      expect(group.value).toBe('a');
      // Space selects the focused option.
      group.handleRadioKey({ key: ' ', preventDefault() {} } as any, 'c');
      expect(group.value).toBe('c');
      expect(onChange).toHaveBeenLastCalledWith('c');
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

    it('projects a role=tab hotspot per tab with aria-selected + roving tabindex', () => {
      const tabs = new Tabs({
        width: 300,
        height: 200,
        tabs: [
          { id: 'tab1', label: 'Tab 1', content: new Entity('t1') },
          { id: 'tab2', label: 'Tab 2', content: new Entity('t2') },
        ],
        value: 'tab1',
      });
      const spots = tabs.children.filter((c) => (c as any).getA11yAttributes?.().role === 'tab');
      expect(spots).toHaveLength(2);
      const attrs = spots.map((s) => (s as any).getA11yAttributes());
      expect(attrs[0]).toMatchObject({
        role: 'tab',
        selected: true,
        tabIndex: 0,
      });
      expect(attrs[1]).toMatchObject({
        role: 'tab',
        selected: false,
        tabIndex: -1,
      });
    });

    it('arrow/Home/End keys move + activate tabs (wrapping)', () => {
      const onChange = vi.fn();
      const tabs = new Tabs({
        width: 300,
        height: 200,
        tabs: [
          { id: 'a', label: 'A', content: new Entity('a') },
          { id: 'b', label: 'B', content: new Entity('b') },
          { id: 'c', label: 'C', content: new Entity('c') },
        ],
        value: 'a',
        onChange,
      });
      tabs.handleTabKey({ key: 'ArrowRight', preventDefault() {} } as any, 'a');
      expect(tabs.value).toBe('b');
      tabs.handleTabKey({ key: 'ArrowLeft', preventDefault() {} } as any, 'b');
      expect(tabs.value).toBe('a');
      tabs.handleTabKey({ key: 'ArrowLeft', preventDefault() {} } as any, 'a'); // wrap
      expect(tabs.value).toBe('c');
      tabs.handleTabKey({ key: 'Home', preventDefault() {} } as any, 'c');
      expect(tabs.value).toBe('a');
      tabs.handleTabKey({ key: 'End', preventDefault() {} } as any, 'a');
      expect(tabs.value).toBe('c');
    });

    it('fires onClose when the × affordance of a tab is clicked', () => {
      const onClose = vi.fn();
      const onChange = vi.fn();
      const tabs = new Tabs({
        width: 320,
        height: 200,
        closable: true,
        onClose,
        onChange,
        tabs: [
          { id: 'a', label: 'A', content: new Entity('a') },
          { id: 'b', label: 'B', content: new Entity('b') },
        ],
        value: 'a',
      });

      // Two tabs, 160px each. Tab A's × sits at x = 160 - 12 = 148.
      tabs.emit('pointerdown', { localX: 148, localY: 20 });
      expect(onClose).toHaveBeenCalledWith('a');
      // Closing must not also switch/select the tab.
      expect(onChange).not.toHaveBeenCalled();
      expect(tabs.value).toBe('a');
    });

    it('does not select a dying tab when a deferred close leaves its hotspot alive (#687)', () => {
      const onClose = vi.fn();
      const onChange = vi.fn();
      const tabs = new Tabs({
        width: 320,
        height: 200,
        closable: true,
        onClose,
        onChange,
        tabs: [
          { id: 'a', label: 'A', content: new Entity('a') },
          { id: 'b', label: 'B', content: new Entity('b') },
        ],
        value: 'b',
      });

      // One physical click on × delivers two events: pointerdown (close) then
      // the mirror's click. With a deferred removal the mirror is still alive
      // when the browser dispatches that click — it must not select the tab.
      tabs.emit('pointerdown', { localX: 148, localY: 20 }); // × of tab 'a'
      expect(onClose).toHaveBeenCalledWith('a');
      const hotspotA = (
        tabs as unknown as { _hotspots: Array<{ emit: (t: string, e?: unknown) => void }> }
      )._hotspots[0];
      hotspotA.emit('click', {});
      expect(tabs.value).toBe('b');
      expect(onChange).not.toHaveBeenCalled();

      // A later genuine click on the hotspot still selects normally.
      hotspotA.emit('click', {});
      expect(tabs.value).toBe('a');
      expect(onChange).toHaveBeenCalledWith('a');
    });

    it('does not stretch tabs beyond tabWidth when the bar has surplus width', () => {
      // Stretched tabs put the right-edge × glyph directly beside the NEXT
      // tab's label — users click the × they see next to a label and close
      // the wrong tab (vem 2026-07-16 finding). Surplus bar width must stay
      // empty instead.
      const tabs = new Tabs({
        width: 1600,
        height: 200,
        tabWidth: 150,
        tabs: ['a', 'b', 'c'].map((id) => ({
          id,
          label: id,
          content: new Entity(id),
        })),
        value: 'a',
      });
      expect((tabs as unknown as { _tabW(): number })._tabW()).toBe(150);
    });

    it('keeps a fixed tab width and scrolls instead of shrinking with many tabs', () => {
      const many = Array.from({ length: 20 }, (_, i) => ({
        id: `t${i}`,
        label: `Tab ${i + 1}`,
        content: new Entity(`t${i}`),
      }));
      const tabs = new Tabs({
        width: 600,
        height: 200,
        tabWidth: 160,
        minTabWidth: 96,
        tabs: many,
        value: 't0',
      });

      const w = (tabs as unknown as { _tabW(): number })._tabW();
      // 20 × 96 = 1920 > 600, so tabs cannot fit — width holds at minTabWidth,
      // never collapses to 600/20 = 30px slivers.
      expect(w).toBe(96);

      // Selecting a far tab scrolls it into view rather than squeezing.
      tabs.emit('change', { value: 't19' });
      const scrollX = (tabs as unknown as { _scrollX: number })._scrollX;
      expect(scrollX).toBeGreaterThan(0);
      const activeLeft = 19 * w;
      expect(scrollX).toBeLessThanOrEqual(activeLeft);
      expect(scrollX + 600).toBeGreaterThanOrEqual(activeLeft + w);
    });

    it('autoHideTabBar hides the bar for a single tab and gives content the full height', () => {
      const content = new Entity();
      const onClose = vi.fn();
      const tabs = new Tabs({
        width: 400,
        height: 300,
        tabHeight: 30,
        closable: true,
        autoHideTabBar: true,
        onClose,
        tabs: [{ id: 'only', label: 'untitled', content }],
        value: 'only',
      });
      tabs.update(0, 0);

      expect(tabs.effectiveTabBarHeight).toBe(0);
      expect(content.y).toBe(0);
      expect(content.height).toBe(300);

      // The former bar strip must be inert — no invisible tab switching or
      // closing where the bar used to be.
      tabs.emit('pointerdown', { localX: 138, localY: 10 });
      expect(onClose).not.toHaveBeenCalled();
      expect(tabs.value).toBe('only');
    });

    it('autoHideTabBar brings the bar back as soon as a second tab exists', () => {
      const first = new Entity();
      const second = new Entity();
      const tabs = new Tabs({
        width: 400,
        height: 300,
        tabHeight: 30,
        autoHideTabBar: true,
        tabs: [{ id: 'a', label: 'a', content: first }],
        value: 'a',
      });
      tabs.update(0, 0);
      expect(tabs.effectiveTabBarHeight).toBe(0);

      // Owners reassign the public `tabs` field directly (no change emit) —
      // geometry must still follow on the next frame.
      tabs.tabs = [
        { id: 'a', label: 'a', content: first },
        { id: 'b', label: 'b', content: second },
      ];
      tabs.update(0, 0);

      expect(tabs.effectiveTabBarHeight).toBe(30);
      expect(first.y).toBe(30);
      expect(first.height).toBe(270);

      // And it hides again when back to one tab (last-tab close reset).
      tabs.tabs = [{ id: 'a', label: 'a', content: first }];
      tabs.update(0, 0);
      expect(tabs.effectiveTabBarHeight).toBe(0);
      expect(first.y).toBe(0);
      expect(first.height).toBe(300);
    });

    it('keeps the bar for a single tab by default (autoHideTabBar off)', () => {
      const content = new Entity();
      const tabs = new Tabs({
        width: 400,
        height: 300,
        tabHeight: 30,
        tabs: [{ id: 'only', label: 'untitled', content }],
        value: 'only',
      });
      tabs.update(0, 0);

      expect(tabs.effectiveTabBarHeight).toBe(30);
      expect(content.y).toBe(30);
      expect(content.height).toBe(270);
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
