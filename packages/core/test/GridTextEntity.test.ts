// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { GridTextEntity } from '../src/components/GridTextEntity';

const mockRenderer = {
  save: vi.fn(),
  restore: vi.fn(),
  translate: vi.fn(),
  fillText: vi.fn(),
};

describe('GridTextEntity', () => {
  it('constructor sets default values', () => {
    const entity = new GridTextEntity({}, 12);
    expect(entity.fontSize).toBe(12);
    expect(entity.charWidth).toBe(12);
    expect(entity.charHeight).toBeCloseTo(13.2);
    expect(entity.interactive).toBe(false);
  });

  it('updateGrid updates dimensions', () => {
    const entity = new GridTextEntity({});
    entity.updateGrid(['hello', 'world']);
    expect(entity.rows).toBe(2);
    expect(entity.cols).toBe(5);
    expect(entity.grid).toEqual(['hello', 'world']);
  });

  it('isPointInside always returns false', () => {
    const entity = new GridTextEntity({});
    expect(entity.isPointInside(0, 0)).toBe(false);
  });

  it('render calls fillText for non-space characters and skips spaces', () => {
    const entity = new GridTextEntity({}, 10);
    entity.updateGrid(['a b']);

    mockRenderer.save.mockClear();
    mockRenderer.translate.mockClear();
    mockRenderer.fillText.mockClear();
    mockRenderer.restore.mockClear();

    entity.render(mockRenderer as any);

    expect(mockRenderer.save).toHaveBeenCalledTimes(2);

    expect(mockRenderer.translate).toHaveBeenNthCalledWith(1, 0, 8);
    expect(mockRenderer.fillText).toHaveBeenNthCalledWith(
      1,
      'a',
      0,
      0,
      'bold 10px monospace',
      '#ffffff',
    );

    expect(mockRenderer.translate).toHaveBeenNthCalledWith(2, 20, 8);
    expect(mockRenderer.fillText).toHaveBeenNthCalledWith(
      2,
      'b',
      0,
      0,
      'bold 10px monospace',
      '#ffffff',
    );

    expect(mockRenderer.restore).toHaveBeenCalledTimes(2);
  });

  it('render returns immediately if rows is 0', () => {
    const entity = new GridTextEntity({});
    mockRenderer.save.mockClear();
    entity.render(mockRenderer as any);
    expect(mockRenderer.save).not.toHaveBeenCalled();
  });
});
