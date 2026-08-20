// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Scene } from '@vectojs/core';
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
});
