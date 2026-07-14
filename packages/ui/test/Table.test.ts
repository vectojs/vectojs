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
});
