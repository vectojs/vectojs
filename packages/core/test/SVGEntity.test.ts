// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { SVGEntity } from '../src/text/SVGEntity';

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
});
