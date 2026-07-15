// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { Rect, Circle, Group, type IRenderer } from '../src/index';

/** A mock IRenderer that records the drawing ops (and their args) in order. */
function recorder() {
  const calls: { op: string; args: unknown[] }[] = [];
  const rec =
    (op: string) =>
    (...args: unknown[]) => {
      calls.push({ op, args });
    };
  const r = {
    clear: rec('clear'),
    save: rec('save'),
    restore: rec('restore'),
    translate: rec('translate'),
    scale: rec('scale'),
    rotate: rec('rotate'),
    setGlobalAlpha: rec('setGlobalAlpha'),
    clip: rec('clip'),
    beginPath: rec('beginPath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    bezierCurveTo: rec('bezierCurveTo'),
    closePath: rec('closePath'),
    arc: rec('arc'),
    roundRect: rec('roundRect'),
    drawImage: rec('drawImage'),
    fill: rec('fill'),
    stroke: rec('stroke'),
    fillText: rec('fillText'),
    fillCircle: rec('fillCircle'),
    flush: rec('flush'),
    createLinearGradient: vi.fn(),
  } as unknown as IRenderer;
  return { r, calls };
}

describe('Rect', () => {
  it('renders a corner-origin box with fill, and reports matching bounds/size', () => {
    const box = new Rect({ width: 120, height: 64, fill: '#38bdf8' });
    expect(box.width).toBe(120);
    expect(box.height).toBe(64);
    expect(box.getBounds()).toEqual({ x: 0, y: 0, width: 120, height: 64 });

    const { r, calls } = recorder();
    box.render(r);
    // Sharp corners: explicit path (no roundRect), then a fill with the color.
    expect(calls.some((c) => c.op === 'roundRect')).toBe(false);
    expect(calls.filter((c) => c.op === 'lineTo')).toHaveLength(3);
    const fill = calls.find((c) => c.op === 'fill');
    expect(fill?.args[0]).toBe('#38bdf8');
    expect(calls.some((c) => c.op === 'stroke')).toBe(false);
  });

  it('uses roundRect when radius > 0 and strokes when a stroke is set', () => {
    const box = new Rect({ width: 40, height: 40, radius: 8, stroke: '#000', strokeWidth: 2 });
    const { r, calls } = recorder();
    box.render(r);
    const rr = calls.find((c) => c.op === 'roundRect');
    expect(rr?.args).toEqual([0, 0, 40, 40, 8]);
    const stroke = calls.find((c) => c.op === 'stroke');
    expect(stroke?.args).toEqual(['#000', 2]);
  });

  it('hit-tests the local box via worldToLocal', () => {
    const box = new Rect({ width: 100, height: 50 });
    box.set({ x: 10, y: 20 });
    expect(box.isPointInside(10, 20)).toBe(true); // top-left corner
    expect(box.isPointInside(110, 70)).toBe(true); // bottom-right corner
    expect(box.isPointInside(9, 20)).toBe(false); // just left
    expect(box.isPointInside(60, 90)).toBe(false); // below
  });

  it('opts into the batch rect only for a plain solid fill', () => {
    expect(new Rect({ width: 10, height: 10, fill: '#f00' }).getBatchRect()).toEqual({
      width: 10,
      height: 10,
      color: '#f00',
    });
    expect(new Rect({ width: 10, height: 10, fill: '#f00', radius: 4 }).getBatchRect()).toBeNull();
    expect(
      new Rect({ width: 10, height: 10, fill: '#f00', stroke: '#0f0' }).getBatchRect(),
    ).toBeNull();
    expect(new Rect({ width: 10, height: 10, fill: null }).getBatchRect()).toBeNull();
  });
});

describe('Circle', () => {
  it('is centered on the origin: bounds and a11y box straddle (0,0)', () => {
    const dot = new Circle({ radius: 24, fill: '#f97316' });
    expect(dot.getBounds()).toEqual({ x: -24, y: -24, width: 48, height: 48 });
    expect(dot.width).toBe(48);
    expect(dot.height).toBe(48);
    expect(dot.a11yOffsetX).toBe(-24);
    expect(dot.a11yOffsetY).toBe(-24);
  });

  it('keeps the box in sync when radius changes via the setter', () => {
    const dot = new Circle({ radius: 10 });
    dot.radius = 30;
    expect(dot.getBounds()).toEqual({ x: -30, y: -30, width: 60, height: 60 });
    expect(dot.a11yOffsetX).toBe(-30);
  });

  it('renders an arc centered at the origin', () => {
    const dot = new Circle({ radius: 12, fill: '#fff' });
    const { r, calls } = recorder();
    dot.render(r);
    const arc = calls.find((c) => c.op === 'arc');
    expect(arc?.args).toEqual([0, 0, 12, 0, Math.PI * 2]);
    expect(calls.find((c) => c.op === 'fill')?.args[0]).toBe('#fff');
  });

  it('hit-tests by distance to origin in local space', () => {
    const dot = new Circle({ radius: 20 });
    dot.set({ x: 100, y: 100 });
    expect(dot.isPointInside(100, 100)).toBe(true); // center
    expect(dot.isPointInside(119, 100)).toBe(true); // inside radius
    expect(dot.isPointInside(121, 100)).toBe(false); // outside radius
    expect(dot.isPointInside(115, 115)).toBe(false); // corner of bbox, outside disc
  });

  it('opts into the batch circle only for a plain solid fill', () => {
    expect(new Circle({ radius: 5, fill: '#f00' }).getBatchCircle()).toEqual({
      radius: 5,
      color: '#f00',
    });
    expect(new Circle({ radius: 5, fill: '#f00', stroke: '#0f0' }).getBatchCircle()).toBeNull();
    expect(new Circle({ radius: 5, fill: null }).getBatchCircle()).toBeNull();
  });
});

describe('Group', () => {
  it('is transparent to hit-testing and draws nothing', () => {
    const g = new Group();
    expect(g.isPointInside()).toBe(false);
    const { r, calls } = recorder();
    g.render(r);
    expect(calls).toHaveLength(0);
  });

  it('adopts inline children and composes its transform onto them', () => {
    const a = new Rect({ width: 10, height: 10 });
    const b = new Circle({ radius: 5 });
    const g = new Group(a, b);
    expect(g.children).toEqual([a, b]);
    expect(a.parent).toBe(g);
    expect(b.parent).toBe(g);

    // A child's world position reflects the group's transform.
    g.set({ x: 100, y: 50 });
    a.set({ x: 5, y: 5 });
    expect(a.getGlobalPosition()).toEqual({ x: 105, y: 55 });
  });
});

describe('Entity.set()', () => {
  it('assigns own properties through their setters and returns this', () => {
    const box = new Rect();
    const ret = box.set({ x: 40, y: 40, width: 120, fill: '#38bdf8' });
    expect(ret).toBe(box);
    expect(box.x).toBe(40);
    expect(box.y).toBe(40);
    expect(box.width).toBe(120);
    expect(box.fill).toBe('#38bdf8');
  });

  it('routes transform props through the transition-aware setter', () => {
    const box = new Rect();
    box.setTransition({ x: { duration: 100 } });
    // With a transition configured, assigning x must NOT snap instantly.
    box.set({ x: 500 });
    expect(box.x).toBe(0); // driver spawned; value still at its start until ticked
  });
});

describe('Entity.add() variadic', () => {
  it('adds multiple children in one call, in order', () => {
    const parent = new Group();
    const a = new Rect();
    const b = new Rect();
    const c = new Rect();
    const ret = parent.add(a, b, c);
    expect(ret).toBe(parent);
    expect(parent.children).toEqual([a, b, c]);
    expect(c.parent).toBe(parent);
  });

  it('still supports the single-child call', () => {
    const parent = new Group();
    const a = new Rect();
    parent.add(a);
    expect(parent.children).toEqual([a]);
  });
});
