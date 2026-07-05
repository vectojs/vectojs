// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { SVGEntity } from '../src/text/SVGEntity';
import { SVGRenderer } from '../src/renderer/SVGRenderer';

describe('SVGEntity', () => {
  it('parses dimensions correctly', () => {
    const svg = '<svg width="200" height="150"><rect/></svg>';
    const entity = new SVGEntity(svg);
    expect(entity.width).toBe(200);
    expect(entity.height).toBe(150);
  });

  it('falls back to regex parsing when window is undefined', () => {
    const svg = '<svg width="300" height="200"><rect/></svg>';
    // Temporarily delete window
    const originalWindow = global.window;
    // @ts-ignore
    delete global.window;

    const entity = new SVGEntity(svg);
    expect(entity.width).toBe(300);
    expect(entity.height).toBe(200);

    // Restore window
    global.window = originalWindow;
  });

  it('hit-tests through rotation and non-uniform scale', () => {
    const entity = new SVGEntity('<svg width="200" height="150"><rect/></svg>');
    entity.setPosition(25, 40);
    entity.scaleX = 1.75;
    entity.scaleY = 0.6;
    entity.rotation = Math.PI / 5;

    const inside = entity.localToWorld(100, 75);
    const outside = entity.localToWorld(201, 75);
    expect(entity.isPointInside(inside.x, inside.y)).toBe(true);
    expect(entity.isPointInside(outside.x, outside.y)).toBe(false);
  });

  it('exports its source as an encoded nested SVG image instead of an inert placeholder', () => {
    const entity = new SVGEntity(
      '<svg width="20" height="10"><rect width="20" height="10" fill="red"/></svg>',
    );
    const renderer = new SVGRenderer(20, 10);

    entity.render(renderer);
    const output = renderer.toXMLString();

    expect(output).toContain('href="data:image/svg+xml;charset=utf-8,');
    expect(output).not.toContain('href="#"');
    expect(() => new DOMParser().parseFromString(output, 'image/svg+xml')).not.toThrow();
  });
});
