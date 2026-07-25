// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Table } from '../src/Table';
import { Scene } from '@vectojs/core';

describe('Table', () => {
  beforeEach(() => {
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type: string) {
      if (type === '2d') {
        return {
          font: '',
          fillStyle: '',
          measureText: (text: string) => ({ width: text.length * 7 }),
          fillText: vi.fn(),
          scale: () => {},
          clearRect: () => {},
          save: () => {},
          restore: () => {},
          translate: () => {},
          rotate: () => {},
          beginPath: vi.fn(),
          rect: vi.fn(),
          roundRect: vi.fn(),
          fill: vi.fn(),
          stroke: vi.fn(),
          moveTo: vi.fn(),
          lineTo: vi.fn(),
          clip: () => {},
        } as any;
      }
      return originalGetContext.apply(this, arguments as any);
    };
  });

  it('correctly initializes properties and layout box dimensions', () => {
    const table = new Table({
      headers: ['Col A', 'Col B'],
      rows: [
        ['Val A1', 'Val B1'],
        ['Val A2', 'Val B2'],
      ],
      width: 400,
      rowHeight: 40,
    });

    expect(table.width).toBe(400);
    expect(table.height).toBe(120); // (2 rows + 1 header) * 40
    expect(table.colWidths).toEqual([200, 200]);
    expect(table.interactive).toBe(true);
  });

  it('provides Table A11y Landmark Attributes', () => {
    const table = new Table({
      headers: ['Col A', 'Col B'],
      rows: [['Val A1', 'Val B1']],
      width: 300,
    });
    const attrs = table.getA11yAttributes();
    expect(attrs.role).toBe('grid');
    expect(attrs.label).toContain('2 columns');
    expect(attrs.pointerEvents).toBe('none');
  });

  it('draws headers, cells, and grids without errors in renderer', () => {
    const canvas = document.createElement('canvas');
    const scene = new Scene(canvas);
    const table = new Table({
      headers: ['A', 'B'],
      rows: [['A1', 'B1']],
      width: 300,
      rowHeight: 30,
    });
    scene.add(table);

    const renderer = scene.renderer;
    const fillTextSpy = vi.spyOn(renderer, 'fillText');
    const strokeSpy = vi.spyOn(renderer, 'stroke');

    scene.step(0);

    // Cell Text entities draw through the VMT child pass; Table.render only
    // paints the background and grid and must not mutate cell geometry.
    expect(fillTextSpy).toHaveBeenCalled();
    // Should draw row line / column line / outer border
    expect(strokeSpy).toHaveBeenCalled();
  });

  describe('virtualization (viewportHeight)', () => {
    function makeTable(rowCount: number) {
      return new Table({
        headers: ['A', 'B'],
        rows: Array.from({ length: rowCount }, (_, i) => [`a${i}`, `b${i}`]),
        width: 300,
        rowHeight: 30,
        viewportHeight: 300, // header 30 + body 270 ≈ 9 rows
      });
    }
    // The clipped body sub-container holds the mounted body cells.
    const bodyClip = (t: Table) => (t as any).bodyClip as { children: unknown[] };
    const mounted = (t: Table) => (t as any).mountedRows as Set<number>;

    it('mounts only a viewport-worth of body rows, not the whole table', () => {
      // 800 rows is plenty to prove the point — the mounted count is bounded by
      // the viewport, not the row total — while keeping cell-entity construction
      // cheap enough to stay well under the CI test timeout (10k rows = 20k Text
      // entities took >5s on slower runners).
      const t = makeTable(800);
      // header 30 + 270/30 = 9 visible rows + overscan(2 each side) ≈ ≤ 13 rows.
      expect(mounted(t).size).toBeLessThanOrEqual(13);
      expect(mounted(t).size).toBeGreaterThan(0);
      // Body clip holds only those rows' cells (2 cols each), far below 1600.
      expect(bodyClip(t).children.length).toBe(mounted(t).size * 2);
      // The table's own height is the fixed viewport, not the full content.
      expect(t.height).toBe(300);
    });

    it('mounts rows around the scrolled position after a wheel scroll', () => {
      const canvas = document.createElement('canvas');
      const scene = new Scene(canvas);
      const t = makeTable(400);
      scene.add(t);
      const before = new Set(mounted(t));
      expect(before.has(0)).toBe(true);

      // Scroll ~200 rows down and settle the integrator.
      t.emit('wheel', { deltaY: 200 * 30, preventDefault() {} });
      for (let i = 0; i < 300; i++) t.update(16, i * 16);

      const after = mounted(t);
      expect(after.has(0)).toBe(false); // row 0 unmounted
      expect([...after].some((i) => i >= 190 && i <= 210)).toBe(true); // ~200 mounted
    });

    it('classic (no viewportHeight) still mounts every cell and grows to fit', () => {
      const t = new Table({
        headers: ['A', 'B'],
        rows: Array.from({ length: 50 }, (_, i) => [`a${i}`, `b${i}`]),
        width: 300,
        rowHeight: 30,
      });
      expect((t as any).bodyClip).toBeNull();
      // 50 rows × 2 cols body cells + 2 header cells all direct children.
      expect(t.children.length).toBe(50 * 2 + 2);
      // Grows to fit all rows (variable heights ≥ rowHeight), not a fixed
      // viewport — so much taller than any single viewport would be.
      expect(t.height).toBeGreaterThanOrEqual(51 * 30);
    });

    it('reports pending animation while the scroll integrator is settling', () => {
      const t = makeTable(1000);
      t.emit('wheel', { deltaY: 500, preventDefault() {} });
      expect(t.hasPendingAnimations()).toBe(true);
    });
  });
});
