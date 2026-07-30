// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Table } from '../src/Table';
import { Text } from '../src/Text';
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
    const bodyClip = (t: Table) => (t as any).bodyClip as { children: any[] };
    const mounted = (t: Table) => (t as any).mountedRows as Set<number>;
    // Count only the Text cell entities (the grid a11y layer adds transparent
    // RowHotspot/GridCellHotspot children that are not the mounted cells).
    const textCellCount = (children: any[]) =>
      children.filter((c) => c?.constructor?.name === 'Text').length;

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
      expect(textCellCount(bodyClip(t).children)).toBe(mounted(t).size * 2);
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
      // 50 rows × 2 cols body cells + 2 header cells all direct Text children
      // (the grid a11y layer adds transparent row/cell hotspots alongside).
      expect(textCellCount(t.children)).toBe(50 * 2 + 2);
      // Grows to fit all rows (variable heights ≥ rowHeight), not a fixed
      // viewport — so much taller than any single viewport would be.
      expect(t.height).toBeGreaterThanOrEqual(51 * 30);
    });

    it('reports pending animation while the scroll integrator is settling', () => {
      const t = makeTable(1000);
      t.emit('wheel', { deltaY: 500, preventDefault() {} });
      expect(t.hasPendingAnimations()).toBe(true);
    });

    it('scrolls the body on a touch/pointer drag (drag up scrolls down)', () => {
      const canvas = document.createElement('canvas');
      const scene = new Scene(canvas);
      const t = makeTable(400);
      scene.add(t);
      expect(new Set(mounted(t)).has(0)).toBe(true);

      // Finger presses, then drags UP 300px → content scrolls down.
      t.emit('pointerdown', { localY: 350 });
      t.emit('pointermove', { localY: 50 });
      t.emit('pointerup', { localY: 50 });
      for (let i = 0; i < 300; i++) t.update(16, i * 16);

      expect((t as any)._targetY).toBeGreaterThan(0);
      const after = mounted(t);
      expect(after.has(0)).toBe(false);
    });

    it('ignores pointermove drag after pointerup (drag released)', () => {
      const t = makeTable(400);
      t.emit('pointerdown', { localY: 300 });
      t.emit('pointerup', { localY: 300 });
      const parked = (t as any)._targetY;
      t.emit('pointermove', { localY: 0 }); // no active drag → ignored
      expect((t as any)._targetY).toBe(parked);
    });
  });

  describe('a11y: role=grid/row/gridcell + keyboard (E-4b)', () => {
    const cellHotspots = (t: Table) => {
      const out: any[] = [];
      const walk = (e: any) => {
        if (e.getA11yAttributes) {
          const role = e.getA11yAttributes().role;
          if (role === 'gridcell' || role === 'columnheader') out.push(e);
        }
        for (const c of e.children ?? []) walk(c);
      };
      walk(t);
      return out;
    };

    it('projects columnheader + gridcell hotspots inside role=row containers', () => {
      const t = new Table({
        headers: ['Name', 'Age'],
        rows: [
          ['Alice', '30'],
          ['Bob', '25'],
        ],
        width: 240,
      });
      // Header row + 2 body rows are role=row.
      const rows = t.children.filter((c) => (c as any).getA11yAttributes?.().role === 'row');
      expect(rows.length).toBe(3);

      const cells = cellHotspots(t).map((h) => h.getA11yAttributes());
      const headers = cells.filter((a) => a.role === 'columnheader');
      const body = cells.filter((a) => a.role === 'gridcell');
      expect(headers.map((a) => a.label)).toEqual(['Name', 'Age']);
      expect(body.map((a) => a.label)).toEqual(['Alice', '30', 'Bob', '25']);
      // Exactly one roving tab stop across the whole grid (header col 0).
      expect(cells.filter((a) => a.tabIndex === 0)).toHaveLength(1);
    });

    it('table itself is role=grid', () => {
      const t = new Table({ headers: ['A'], rows: [['x']], width: 100 });
      expect(t.getA11yAttributes().role).toBe('grid');
    });

    it('ArrowDown/ArrowRight move the focused cell (roving tabindex follows)', () => {
      const t = new Table({
        headers: ['A', 'B'],
        rows: [
          ['a0', 'b0'],
          ['a1', 'b1'],
        ],
        width: 200,
      });
      // From header col 0, ArrowDown → body row 0 col 0.
      t.handleGridKey({ key: 'ArrowDown', preventDefault() {} } as any, -1, 0);
      expect(t.isGridTabStop(0, 0)).toBe(true);
      // ArrowRight → col 1.
      t.handleGridKey({ key: 'ArrowRight', preventDefault() {} } as any, 0, 0);
      expect(t.isGridTabStop(0, 1)).toBe(true);
      // ArrowUp back to the header row.
      t.handleGridKey({ key: 'ArrowUp', preventDefault() {} } as any, 0, 1);
      expect(t.isGridTabStop(-1, 1)).toBe(true);
      // Clamped at the top edge.
      t.handleGridKey({ key: 'ArrowUp', preventDefault() {} } as any, -1, 1);
      expect(t.isGridTabStop(-1, 1)).toBe(true);
    });

    it('Ctrl+End jumps to the last body row, last column', () => {
      const t = new Table({
        headers: ['A', 'B'],
        rows: [
          ['a0', 'b0'],
          ['a1', 'b1'],
          ['a2', 'b2'],
        ],
        width: 200,
      });
      t.handleGridKey({ key: 'End', ctrlKey: true, preventDefault() {} } as any, -1, 0);
      expect(t.isGridTabStop(2, 1)).toBe(true);
    });
  });

  describe('appendRows', () => {
    // The invariant the whole feature exists for: `layout()` walks the private
    // cell grid while `getA11yAttributes()` counts the public `rows`, so a
    // partial append renders rows it does not announce, or the reverse. Every
    // test here asserts geometry and the announced count together.
    const announced = (t: Table): number =>
      Number(/and (\d+) rows/.exec(t.getA11yAttributes().label ?? '')?.[1] ?? -1);

    it('grows to exactly what a rebuilt table would be', () => {
      const grown = new Table({ headers: ['A', 'B'], rows: [['a1', 'b1']], width: 300 });
      grown.appendRows([
        ['a2', 'b2'],
        ['a3', 'b3'],
      ]);
      const built = new Table({
        headers: ['A', 'B'],
        rows: [
          ['a1', 'b1'],
          ['a2', 'b2'],
          ['a3', 'b3'],
        ],
        width: 300,
      });

      expect(grown.height).toBe(built.height);
      expect(grown.rowHeights).toEqual(built.rowHeights);
      expect(grown.children.length).toBe(built.children.length);
      expect(announced(grown)).toBe(announced(built));
    });

    it('keeps the announced row count in step with the rendered rows', () => {
      // This is the exact failure the feature replaces: pushing onto the public
      // `rows` and calling the public `layout()` announces the new row while
      // leaving it unrendered.
      const t = new Table({ headers: ['A', 'B'], rows: [['a1', 'b1']], width: 300 });
      t.appendRows([['a2', 'b2']]);
      expect(announced(t)).toBe(2);
      expect(t.rowHeights.length).toBe(2);
    });

    it('appends onto a table that started with no rows', () => {
      // A markdown table is lexed with zero rows the moment its delimiter row
      // arrives, so this is the first state a streamed table is ever in.
      const t = new Table({ headers: ['A', 'B'], rows: [], width: 300 });
      t.appendRows([['a1', 'b1']]);
      const built = new Table({ headers: ['A', 'B'], rows: [['a1', 'b1']], width: 300 });
      expect(t.height).toBe(built.height);
      expect(announced(t)).toBe(1);
    });

    it('pads a short row and truncates a long one, as the constructor does', () => {
      const grown = new Table({ headers: ['A', 'B'], rows: [], width: 300 });
      grown.appendRows([['only'], ['x', 'y', 'z']]);
      const built = new Table({
        headers: ['A', 'B'],
        rows: [['only'], ['x', 'y', 'z']],
        width: 300,
      });
      expect(grown.height).toBe(built.height);
      expect(grown.rowHeights).toEqual(built.rowHeights);
      expect(grown.children.length).toBe(built.children.length);
    });

    it('still rejects a duplicate Entity cell', () => {
      // The uniqueness set has to outlive the constructor for this to fire:
      // `Entity.add` silently re-parents, so a reused cell would otherwise be
      // moved out of the row it already occupies.
      // Must be a cell the CALLER supplied: a string cell becomes a `Text` the
      // table created itself, which never enters the uniqueness set.
      const shared = new Text('dup', { font: '14px sans-serif' });
      const t = new Table({ headers: ['A', 'B'], rows: [[shared, 'b1']], width: 300 });
      expect(() => t.appendRows([[shared, 'b2']])).toThrow(
        'Table Entity cells must be unique instances.',
      );
    });

    it('is a no-op for an empty argument', () => {
      const t = new Table({ headers: ['A', 'B'], rows: [['a', 'b']], width: 300 });
      const before = { h: t.height, rows: t.rows.length, kids: t.children.length };
      t.appendRows([]);
      expect({ h: t.height, rows: t.rows.length, kids: t.children.length }).toEqual(before);
    });

    it('announces appended rows in index order', () => {
      // Appended cells land after the hotspots the first layout() created, so
      // visual child order differs from a rebuild. That must not reach an AT:
      // the grid is projected from the hotspot pool, which is rebound by slot
      // index on every layout.
      const t = new Table({ headers: ['A', 'B'], rows: [['a1', 'b1']], width: 300 });
      t.appendRows([['a2', 'b2']]);
      t.appendRows([['a3', 'b3']]);

      const rows: string[] = [];
      const walk = (e: { children?: unknown[]; getA11yAttributes?: () => { role?: string } }) => {
        const attrs = e.getA11yAttributes?.();
        if (attrs?.role === 'row') {
          const labels = (
            e.children as Array<{ getA11yAttributes?: () => { label?: string } }>
          ).map((c) => c.getA11yAttributes?.().label ?? '?');
          rows.push(labels.join('|'));
        }
        for (const c of (e.children ?? []) as (typeof e)[]) walk(c);
      };
      walk(t as never);

      expect(rows).toEqual(['A|B', 'a1|b1', 'a2|b2', 'a3|b3']);
    });

    it('re-measures a cell mutated after mounting', () => {
      // The documented path for a streamed row whose content is still arriving:
      // mutate the cell you passed in, then call layout(). No Table API needed.
      const cell = new Text('a1', { font: '14px sans-serif' });
      const t = new Table({ headers: ['A', 'B'], rows: [[cell, 'b1']], width: 300 });
      const before = t.height;
      cell.setText('a substantially longer value that must wrap across lines');
      t.layout();
      expect(t.height).toBeGreaterThan(before);
    });
  });
});
