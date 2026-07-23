import { describe, it, expect } from 'vitest';
import { buildStore, composeJS, readWorld, type InputNode } from '../../src/wasm/soa';

/** Convenience: a node with identity-ish defaults, overridable. */
function node(parent: number, over: Partial<InputNode> = {}): InputNode {
  return { parent, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, ...over };
}

describe('buildStore', () => {
  it('places the root at store index 0 with no runs', () => {
    const s = buildStore([node(-1)]);
    expect(s.count).toBe(1);
    expect(s.runCount).toBe(0);
    expect(s.storeIndexOf[0]).toBe(0);
  });

  it('emits one contiguous run for a parent with several children', () => {
    // input: 0=root, 1,2,3 = children of root
    const s = buildStore([node(-1), node(0), node(0), node(0)]);
    expect(s.runCount).toBe(1);
    expect(s.runParent[0]).toBe(0);
    expect(s.runStart[0]).toBe(1);
    expect(s.runLen[0]).toBe(3);
    // children got contiguous store indices 1,2,3
    expect([s.storeIndexOf[1], s.storeIndexOf[2], s.storeIndexOf[3]].sort()).toEqual([1, 2, 3]);
  });

  it('assigns every parent a lower store index than its children (depth order)', () => {
    // root -> A,B ; A -> C
    const s = buildStore([node(-1), node(0), node(0), node(1)]);
    const root = s.storeIndexOf[0];
    const a = s.storeIndexOf[1];
    const c = s.storeIndexOf[3];
    expect(root).toBe(0);
    expect(a).toBeLessThan(c);
    // the run owning C is parented on A's store index
    const cRun = [...Array(s.runCount).keys()].find(
      (r) => s.runStart[r] <= c && c < s.runStart[r] + s.runLen[r],
    )!;
    expect(s.runParent[cRun]).toBe(a);
  });

  it('rejects zero or multiple roots', () => {
    expect(() => buildStore([node(0)])).toThrow(/no root/);
    expect(() => buildStore([node(-1), node(-1)])).toThrow(/more than one root/);
  });

  it('precomputes cos/sin per node', () => {
    const s = buildStore([node(-1), node(0, { rotation: Math.PI / 2 })]);
    expect(s.cos[1]).toBeCloseTo(0, 12);
    expect(s.sin[1]).toBeCloseTo(1, 12);
  });
});

describe('composeJS', () => {
  it('composes a pure translation child correctly', () => {
    const s = buildStore([node(-1), node(0, { x: 10, y: 20 })]);
    composeJS(s);
    const w = readWorld(s, s.storeIndexOf[1]);
    expect(w).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 10, f: 20, opacity: 1 });
  });

  it('accumulates opacity down the hierarchy', () => {
    // root -> A(0.5) -> B(0.4)
    const s = buildStore([node(-1), node(0, { opacity: 0.5 }), node(1, { opacity: 0.4 })]);
    composeJS(s);
    expect(readWorld(s, s.storeIndexOf[2]).opacity).toBeCloseTo(0.2, 12);
  });

  it('composes scale then translate in Canvas T*S*R order', () => {
    // parent scales x2 and translates (100,0); child at local (5,0)
    const s = buildStore([
      node(-1),
      node(0, { x: 100, y: 0, scaleX: 2, scaleY: 2 }),
      node(1, { x: 5, y: 0 }),
    ]);
    composeJS(s);
    const w = readWorld(s, s.storeIndexOf[2]);
    // parent world: a2 d2 e100; child local translate (5,0) -> world e = 100 + 2*5 = 110
    expect(w.a).toBeCloseTo(2, 12);
    expect(w.e).toBeCloseTo(110, 12);
    expect(w.f).toBeCloseTo(0, 12);
  });
});
