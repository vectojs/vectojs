import { describe, expect, it } from 'vitest';
import { DisplayLayout } from '../src';

describe('DisplayLayout', () => {
  it('defaults to a single primary display', () => {
    const layout = new DisplayLayout([], 1024, 768, 40, 'bottom');
    expect(layout.primary()).toEqual({
      id: 'primary',
      x: 0,
      y: 0,
      width: 1024,
      height: 768,
    });
    expect(layout.workArea().height).toBe(728);
    expect(layout.workArea().y).toBe(0);
  });

  it('subtracts a top taskbar from the work area', () => {
    const layout = new DisplayLayout(
      [{ id: 'main', x: 0, y: 0, width: 800, height: 600 }],
      800,
      600,
      48,
      'top',
    );
    expect(layout.workArea()).toEqual({
      x: 0,
      y: 48,
      width: 800,
      height: 552,
    });
  });

  it('clamps geometry into the work area', () => {
    const layout = new DisplayLayout(
      [{ id: 'main', x: 0, y: 0, width: 800, height: 600 }],
      800,
      600,
      40,
      'bottom',
    );
    const r = layout.clampRect(-100, -50, 5000, 5000);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
    expect(r.width).toBe(800);
    expect(r.height).toBe(560);
  });

  it('resolves displayAt across a dual setup', () => {
    const layout = new DisplayLayout(
      [
        { id: 'a', x: 0, y: 0, width: 800, height: 600 },
        { id: 'b', x: 800, y: 0, width: 800, height: 600 },
      ],
      1600,
      600,
      0,
      'bottom',
    );
    expect(layout.displayAt(100, 100).id).toBe('a');
    expect(layout.displayAt(900, 100).id).toBe('b');
    expect(layout.bounds().width).toBe(1600);
  });
});
