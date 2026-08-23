// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Entity, Scene } from '@vectojs/core';
import { Text } from '@vectojs/ui';
import { Table } from '../src';

describe('standalone Table package', () => {
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

  it('exports the full table layout and accessibility contract', () => {
    const table = new Table({
      headers: ['Name', 'Status'],
      rows: [['Build', 'Passing']],
      width: 300,
      rowHeight: 40,
    });

    expect(table.width).toBe(300);
    expect(table.height).toBe(80);
    expect(table.getA11yAttributes()).toMatchObject({
      role: 'grid',
      pointerEvents: 'none',
    });
    expect(table.isGridTabStop(-1, 0)).toBe(true);
  });

  it('retains virtualization, keyboard navigation, appendRows, and resizing', () => {
    const table = new Table({
      headers: ['A', 'B'],
      rows: Array.from({ length: 100 }, (_, i) => [`a${i}`, `b${i}`]),
      width: 400,
      rowHeight: 30,
      viewportHeight: 240,
    });

    expect(table.height).toBe(240);
    expect((table as any).mountedRows.size).toBeLessThan(100);

    table.handleGridKey({ key: 'ArrowDown', preventDefault() {} } as any, -1, 0);
    expect(table.isGridTabStop(0, 0)).toBe(true);
    table.appendRows([['a100', 'b100']]);
    expect(table.rows).toHaveLength(101);

    table.setWidth(600);
    expect(table.width).toBe(600);
    expect(table.colWidths).toEqual([300, 300]);
  });

  it('preserves selectable Entity cells and canvas rendering', () => {
    const cell = new Text('copy me', { font: '14px sans-serif' });
    const table = new Table({
      headers: ['Value'],
      rows: [[cell]],
      width: 200,
      selectable: true,
    });
    const scene = new Scene(document.createElement('canvas'));
    scene.add(table);
    const fillTextSpy = vi.spyOn(scene.renderer, 'fillText');

    scene.step(0);

    expect(fillTextSpy).toHaveBeenCalled();
    expect(table.getA11yAttributes().label).toContain('1 columns');
  });

  // ── Issue #606 ──────────────────────────────────────────────────────────────

  /** A minimal KeyboardEvent-like payload for {@link Table.handleGridKey}. */
  const key = (key: string): KeyboardEvent =>
    ({ key, preventDefault() {} }) as unknown as KeyboardEvent;

  /** How many body rows have cell entities constructed (virtualized: lazily). */
  const constructedRowCount = (table: Table): number =>
    ((table as any).bodyCells as Array<Entity[] | null>).filter(Boolean).length;

  /** The (row, col) currently owning the roving tab stop, by probing. */
  const activeCellOf = (table: Table): { row: number; col: number } | null => {
    for (let r = -1; r < table.rows.length; r++) {
      for (let c = 0; c < table.headers.length; c++) {
        if (table.isGridTabStop(r, c)) return { row: r, col: c };
      }
    }
    return null;
  };

  /** Drive one full scene frame (incl. a11y sync); step() skips the a11y pass. */
  const tickScene = (scene: Scene, time = 16): void => {
    (scene as any).isRunning = true;
    (scene as any).loop(time);
  };

  it('materializes virtualized body cells lazily at window construction', () => {
    const rows = Array.from({ length: 400 }, (_, i) => [`a${i}`, `b${i}`]);
    const table = new Table({
      headers: ['A', 'B'],
      rows,
      width: 400,
      rowHeight: 30,
      viewportHeight: 150,
    });
    const mounted = (table as any).mountedRows as Set<number>;

    // Mount-time work is bounded by the window, not the 400 total rows.
    expect(mounted.size).toBeGreaterThan(0);
    expect(mounted.size).toBeLessThan(20);
    // Construction follows mounting exactly: unvisited rows have NO entities.
    expect(constructedRowCount(table)).toBe(mounted.size);
    for (const rowIndex of mounted) {
      const cells = (table as any).bodyCells[rowIndex] as Entity[];
      expect(cells).toHaveLength(2);
      expect((cells[0] as Text).text).toBe(`a${rowIndex}`);
    }

    // Appending batches must not construct off-window cells either.
    table.appendRows(Array.from({ length: 200 }, (_, i) => [`x${i}`, `y${i}`]));
    expect(constructedRowCount(table)).toBe(mounted.size);
    expect(table.rows).toHaveLength(600);

    // Classic mode keeps eager full construction (every cell mounts).
    const classic = new Table({ headers: ['A'], rows: [['1'], ['2'], ['3']], width: 100 });
    expect(constructedRowCount(classic)).toBe(3);
  });

  it('re-anchors roving focus to a visible row when wheel scroll unmounts the focused row', () => {
    // The a11y layer mounts beside the canvas (Scene uses canvas.parentElement),
    // so the canvas must be in the document for focus assertions.
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const scene = new Scene(canvas);
    const rows = Array.from({ length: 80 }, (_, i) => [`r${i}`]);
    const table = new Table({
      headers: ['A'],
      rows,
      width: 200,
      rowHeight: 30,
      viewportHeight: 150,
    });
    scene.add(table);
    tickScene(scene);

    table.handleGridKey(key('ArrowDown'), -1, 0); // header -> body row 0
    expect(document.activeElement?.getAttribute('role')).toBe('gridcell');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('r0');

    // Wheel far past the focused row (the handler's effect on the integrator).
    (table as any)._targetY += 5000;
    (table as any).clampScroll(); // the wheel handler clamps; mirror it
    for (let frame = 1; frame <= 400; frame++) table.update(16, frame * 16);
    tickScene(scene);

    // The old stop must be gone and re-anchored to a mounted row...
    expect(table.isGridTabStop(0, 0)).toBe(false);
    const firstMounted = Math.min(...[...((table as any).mountedRows as Set<number>)]);
    expect(table.isGridTabStop(firstMounted, 0)).toBe(true);
    // ...and keyboard focus must be alive again, not dropped to <body>.
    expect(document.activeElement?.getAttribute('role')).toBe('gridcell');
    expect(document.activeElement?.getAttribute('aria-label')).toBe(`r${firstMounted}`);
  });

  it('keeps DOM focus off the table alone when the scrolled-out cell never held it', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const scene = new Scene(canvas);
    const rows = Array.from({ length: 80 }, (_, i) => [`r${i}`]);
    const table = new Table({
      headers: ['A'],
      rows,
      width: 200,
      rowHeight: 30,
      viewportHeight: 150,
    });
    scene.add(table);
    tickScene(scene);

    // Roving stop parked on row 0 via keyboard, but DOM focus deliberately
    // moved elsewhere (an outside input): scrolling must NOT steal it back.
    table.handleGridKey(key('ArrowDown'), -1, 0);
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    (table as any)._targetY += 5000;
    (table as any).clampScroll(); // the wheel handler clamps; mirror it
    for (let frame = 1; frame <= 400; frame++) table.update(16, frame * 16);
    tickScene(scene);

    expect(document.activeElement).toBe(input);
    expect(table.isGridTabStop(0, 0)).toBe(false);
  });

  it('pages with PageUp/PageDown by one viewport of rows', () => {
    const rows = Array.from({ length: 60 }, (_, i) => [`r${i}`]);
    const table = new Table({
      headers: ['A'],
      rows,
      width: 200,
      rowHeight: 30,
      viewportHeight: 186,
    });
    const pageSize = Math.max(1, Math.floor((186 - table.headerHeight) / 30) - 1);

    table.handleGridKey(key('PageDown'), 0, 0);
    let active = activeCellOf(table);
    expect(active?.row).toBe(Math.min(rows.length - 1, pageSize));

    // Repeated PageDown clamps at the last body row.
    for (let i = 0; i < 60 && active!.row < rows.length - 1; i++) {
      table.handleGridKey(key('PageDown'), active!.row, active!.col);
      active = activeCellOf(table);
    }
    expect(active?.row).toBe(rows.length - 1);

    // Repeated PageUp clamps back at the header boundary (-1).
    for (let i = 0; i < 60 && active!.row > -1; i++) {
      table.handleGridKey(key('PageUp'), active!.row, active!.col);
      active = activeCellOf(table);
    }
    expect(active?.row).toBe(-1);
  });

  it('positions classic pooled rows at monotonically accumulated prefix sums', () => {
    // Narrow width forces some cells to wrap so row heights genuinely differ.
    const rows = [['short'], ['x'.repeat(60)], ['tiny'], ['y'.repeat(60)], ['ok']];
    const table = new Table({ headers: ['C'], rows, width: 120, rowHeight: 24 });
    const pool = (table as any).bodyRowPool as Array<{ row: { y: number } }>;
    expect(pool).toHaveLength(rows.length);

    let expectedTop = table.headerHeight;
    for (let i = 0; i < pool.length; i++) {
      expect(pool[i].row.y).toBe(expectedTop);
      expectedTop += table.rowHeights[i];
    }
  });

  it('declares layout-controlled properties on cell hotspots like RowHotspot', () => {
    const table = new Table({
      headers: ['A', 'B'],
      rows: [['1', '2']],
      width: 200,
    });
    const headerHotspot = (table as any).headerCellHotspots[0];
    expect(headerHotspot.getLayoutControlledProperties()).toEqual(['x', 'y', 'width', 'height']);
    const bodyCell = (
      (table as any).bodyRowPool as Array<{
        cells: Array<{ getLayoutControlledProperties(): string[] }>;
      }>
    )[0].cells[0];
    expect(bodyCell.getLayoutControlledProperties()).toEqual(['x', 'y', 'width', 'height']);
  });
});
