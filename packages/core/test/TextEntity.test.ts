// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { TextEntity } from '../src/components/TextEntity';

const mockAtlas = {
  A: {
    width: 24,
    baseSize: 24,
    ast: {
      paths: [
        {
          commands: [
            { type: 'M', x: 0, y: 0 },
            { type: 'L', x: 10, y: 10 },
            { type: 'C', x1: 5, y1: 5, x2: 15, y2: 15, x: 20, y: 20 },
            { type: 'Z' },
          ],
        },
      ],
    },
  },
};

const mockRenderer = {
  save: vi.fn(),
  restore: vi.fn(),
  translate: vi.fn(),
  scale: vi.fn(),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  bezierCurveTo: vi.fn(),
  closePath: vi.fn(),
  fill: vi.fn(),
  stroke: vi.fn(),
  fillText: vi.fn(),
};

describe('TextEntity', () => {
  it('constructor lays out text and sets size', () => {
    const textEntity = new TextEntity('A', mockAtlas, 200, 24);
    expect(textEntity.text).toBe('A');
    expect(textEntity.width).toBe(200); // LayoutEngine sets totalWidth to maxWidth
    expect(textEntity.height).toBe(36); // fontSize (24) * 1.5
  });

  it('isPointInside check bounds', () => {
    const textEntity = new TextEntity('A', mockAtlas, 200, 24);
    textEntity.setPosition(10, 10);
    expect(textEntity.isPointInside(10, 10)).toBe(true);
    expect(textEntity.isPointInside(20, 20)).toBe(true);
    expect(textEntity.isPointInside(5, 5)).toBe(false);
    expect(textEntity.isPointInside(250, 50)).toBe(false);
  });

  it('renders vector glyph from atlas', () => {
    const textEntity = new TextEntity('A', mockAtlas, 200, 24);
    mockRenderer.save.mockClear();
    mockRenderer.translate.mockClear();
    mockRenderer.scale.mockClear();
    mockRenderer.beginPath.mockClear();
    mockRenderer.moveTo.mockClear();
    mockRenderer.lineTo.mockClear();
    mockRenderer.bezierCurveTo.mockClear();
    mockRenderer.closePath.mockClear();
    mockRenderer.fill.mockClear();

    textEntity.render(mockRenderer as any);

    expect(mockRenderer.save).toHaveBeenCalled();
    expect(mockRenderer.translate).toHaveBeenCalledWith(0, 0);
    expect(mockRenderer.scale).toHaveBeenCalledWith(1, 1);
    expect(mockRenderer.beginPath).toHaveBeenCalled();
    expect(mockRenderer.moveTo).toHaveBeenCalledWith(0, 0);
    expect(mockRenderer.lineTo).toHaveBeenCalledWith(10, 10);
    expect(mockRenderer.bezierCurveTo).toHaveBeenCalledWith(5, 5, 15, 15, 20, 20);
    expect(mockRenderer.closePath).toHaveBeenCalled();
    expect(mockRenderer.fill).toHaveBeenCalledWith('#94a3b8');
    expect(mockRenderer.restore).toHaveBeenCalled();
  });

  it('renders native text when glyph is missing in atlas', () => {
    const textEntity = new TextEntity('B', mockAtlas, 200, 24);
    mockRenderer.save.mockClear();
    mockRenderer.translate.mockClear();
    mockRenderer.fillText.mockClear();
    mockRenderer.restore.mockClear();

    textEntity.render(mockRenderer as any);

    expect(mockRenderer.save).toHaveBeenCalled();
    expect(mockRenderer.translate).toHaveBeenCalledWith(0, 24 * 0.8);
    expect(mockRenderer.fillText).toHaveBeenCalledWith('B', 0, 0, '24px sans-serif', '#94a3b8');
    expect(mockRenderer.restore).toHaveBeenCalled();
  });

  it('hover event updates style', () => {
    const textEntity = new TextEntity('A', mockAtlas, 200, 24);
    expect((textEntity as any).isHovered).toBe(false);

    textEntity.emit('hover', {});
    expect((textEntity as any).isHovered).toBe(true);

    mockRenderer.fill.mockClear();
    textEntity.render(mockRenderer as any);
    expect(mockRenderer.fill).toHaveBeenCalledWith('#ffffff');

    textEntity.emit('pointerleave', {});
    expect((textEntity as any).isHovered).toBe(false);
  });
});
