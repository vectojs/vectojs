// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Entity } from '@vectojs/core';
import { DOMProjection } from '../src/DOMProjection';

class ProbeNode extends Entity {
  public text = 'hello';
  public label = 'press';
  public value = 'typed';

  constructor(id: string) {
    super(id);
    this.domPolicy = 'dom';
    this.domKind = 'text';
    this.width = 200;
    this.height = 24;
  }

  override isPointInside(): boolean {
    return true;
  }

  override render(): void {}
}

describe('DOMProjection lifecycle (RFC §4)', () => {
  let canvas: HTMLCanvasElement;
  let projection: DOMProjection;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    projection = new DOMProjection(canvas);
  });

  afterEach(() => {
    projection.dispose();
    canvas.remove();
    document.body.innerHTML = '';
  });

  it('creates the visual root below the a11y layer', () => {
    const root = projection.getRoot();
    expect(root).toBeTruthy();
    expect(root!.style.zIndex).toBe('9');
    expect(root!.style.pointerEvents).toBe('none');
  });

  it('inserts the root before a11yRoot when present', () => {
    projection.dispose();
    const a11y = document.createElement('div');
    a11y.setAttribute('data-vecto-a11y-root', '');
    canvas.parentElement!.appendChild(a11y);
    projection = new DOMProjection(canvas);
    const root = projection.getRoot()!;
    expect(root.nextElementSibling).toBe(a11y);
  });

  it('mounts a live element with the mandatory origin and id', () => {
    const node = new ProbeNode('t1');
    projection.update(node, { a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 });
    expect(node.domResident).toBe(true);
    const el = projection.getElement('t1')!;
    expect(el).toBeTruthy();
    expect(el.getAttribute('data-vecto-id')).toBe('t1');
    expect(el.style.position).toBe('absolute');
    expect(el.style.transformOrigin).toBe('0 0');
    expect(el.style.transform).toBe('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 0, 1)');
    expect(el.textContent).toBe('hello');
    expect(el.style.userSelect).toBe('text');
  });

  it('dirty-checks: steady-state frames write nothing', () => {
    const node = new ProbeNode('t2');
    const m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    projection.update(node, m);
    const afterFirst = projection.getStats();
    expect(afterFirst.transformWrites).toBe(1);
    expect(afterFirst.contentWrites).toBe(1);
    projection.update(node, { ...m });
    projection.update(node, { ...m });
    const afterSteady = projection.getStats();
    expect(afterSteady.transformWrites).toBe(1);
    expect(afterSteady.contentWrites).toBe(1);
  });

  it('rewrites the transform on move (rotate/scale persistence)', () => {
    const node = new ProbeNode('t3');
    projection.update(node, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    projection.update(node, { a: 0, b: 1, c: -1, d: 0, e: 40, f: 50 });
    expect(projection.getStats().transformWrites).toBe(2);
    expect(projection.getElement('t3')!.style.transform).toBe(
      'matrix3d(0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 40, 50, 0, 1)',
    );
  });

  it('unmounts and pools the element for reuse', () => {
    const node = new ProbeNode('t4');
    projection.update(node, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    const first = projection.getElement('t4')!;
    projection.unmount(node);
    expect(node.domResident).toBe(false);
    expect(document.querySelector('[data-vecto-id="t4"]')).toBeNull();
    expect(projection.getStats().unmounts).toBe(1);
    // Idempotent: a second unmount is a no-op, not a second stat.
    projection.unmount(node);
    expect(projection.getStats().unmounts).toBe(1);
    // Re-mount claims the pooled element.
    projection.update(node, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    expect(projection.getStats().poolHits).toBe(1);
    expect(projection.getElement('t4')).toBe(first);
    expect(projection.getElement('t4')!.textContent).toBe('hello');
  });

  it('falls back focus to the sentinel when unmounting a focused subtree', () => {
    const node = new ProbeNode('t5');
    node.domKind = 'input';
    projection.update(node, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    const el = projection.getElement('t5') as HTMLInputElement;
    el.focus();
    expect(document.activeElement).toBe(el);
    projection.unmount(node);
    expect(document.activeElement).not.toBe(el);
    expect(document.activeElement?.getAttribute('aria-hidden')).toBe('true');
  });

  it('supports custom kinds via registerKind', () => {
    const node = new ProbeNode('t6');
    node.domKind = 'badge';
    projection.registerKind('badge', {
      tag: 'span',
      create: () => document.createElement('span'),
      sync: (n, el, fields) => {
        fields.write('text', (n as unknown as { text: string }).text, (v) => {
          el.textContent = `(${v})`;
        });
      },
    });
    projection.update(node, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    const el = projection.getElement('t6')!;
    expect(el.tagName.toLowerCase()).toBe('span');
    expect(el.textContent).toBe('(hello)');
  });

  it('never goes resident without a DOM parent (canvas fallback)', () => {
    const orphan = document.createElement('canvas');
    const ssrLike = new DOMProjection(orphan);
    expect(ssrLike.getRoot()).toBeNull();
    const node = new ProbeNode('t7');
    ssrLike.update(node, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    expect(node.domResident).toBe(false);
    ssrLike.dispose();
  });
});

describe('DOMProjection clipChildren agreement (r5)', () => {
  let canvas: HTMLCanvasElement;
  let projection: DOMProjection;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    projection = new DOMProjection(canvas);
  });

  afterEach(() => {
    projection.dispose();
    canvas.remove();
    document.body.innerHTML = '';
  });

  const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

  /** Clipper 100x100 at the origin with a 200x200 child offset by (50, 0). */
  function clippedTree(): { clipper: ProbeNode; child: ProbeNode } {
    const clipper = new ProbeNode('clip');
    clipper.clipChildren = true;
    clipper.width = 100;
    clipper.height = 100;
    const child = new ProbeNode('clipped');
    child.width = 200;
    child.height = 200;
    child.x = 50;
    clipper.add(child);
    return { clipper, child };
  }

  /** Parse a `polygon(xpx ypx, …)` style string into points. */
  function parsePolygon(style: string): Array<{ x: number; y: number }> {
    return [...style.matchAll(/(-?[\d.]+)px (-?[\d.]+)px/g)].map((m) => ({
      x: Number(m[1]),
      y: Number(m[2]),
    }));
  }

  /** Hit-side oracle via public core API (mirrors HitTester.isInsideAllClippers). */
  function insideAllClippers(node: Entity, wx: number, wy: number): boolean {
    for (let a = node.parent; a; a = a.parent) {
      if (!a.clipChildren) continue;
      const local = a.worldToLocal(wx, wy);
      if (!local || local.x < 0 || local.y < 0 || local.x > a.width || local.y > a.height) {
        return false;
      }
    }
    return true;
  }

  /** Render-side oracle: ray-cast point-in-polygon over the applied clip. */
  function insidePolygon(pts: Array<{ x: number; y: number }>, lx: number, ly: number): boolean {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x;
      const yi = pts[i].y;
      const xj = pts[j].x;
      const yj = pts[j].y;
      if (yi > ly !== yj > ly && lx < ((xj - xi) * (ly - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  it('applies the clipper intersection as clip-path, dirty-checked', () => {
    const { child } = clippedTree();
    projection.update(child, child.getWorldTransform());
    const el = projection.getElement('clipped')!;
    // Clipper [0,0,100,100] in child-local (child at x=50): [-50,50]x[0,100].
    expect(el.style.clipPath).toBe('polygon(-50px 0px, 50px 0px, 50px 100px, -50px 100px)');
    expect(projection.getStats().clipWrites).toBe(1);
    // Steady-state: no rewrite.
    projection.update(child, child.getWorldTransform());
    expect(projection.getStats().clipWrites).toBe(1);
  });

  it('render and hit-test agree under a clipper', () => {
    const { child } = clippedTree();
    projection.update(child, child.getWorldTransform());
    const pts = parsePolygon(projection.getElement('clipped')!.style.clipPath);
    expect(pts).toHaveLength(4);
    // [worldX, worldY]; every sample is inside the child's own box, so the
    // clipper alone decides the hit — render must match it point for point.
    const samples: Array<[number, number]> = [
      [60, 10],
      [150, 10],
      [90, 90],
      [90, 150],
      [249, 199],
    ];
    for (const [wx, wy] of samples) {
      expect(child.isPointInside(wx, wy)).toBe(true);
      const local = child.worldToLocal(wx, wy)!;
      expect(insidePolygon(pts, local.x, local.y)).toBe(insideAllClippers(child, wx, wy));
    }
    // Spot-check the deciding pair directly: (150,10) is geometrically inside
    // the child but outside the clipper — hit says miss, render hides it.
    expect(insideAllClippers(child, 150, 10)).toBe(false);
    expect(insidePolygon(pts, 100, 10)).toBe(false);
    expect(insideAllClippers(child, 60, 10)).toBe(true);
    expect(insidePolygon(pts, 10, 10)).toBe(true);
  });

  it('intersects nested clippers', () => {
    const outer = new ProbeNode('outer');
    outer.clipChildren = true;
    outer.width = 100;
    outer.height = 100;
    const inner = new ProbeNode('inner');
    inner.clipChildren = true;
    inner.width = 100;
    inner.height = 100;
    inner.x = 25;
    const leaf = new ProbeNode('leaf');
    leaf.width = 200;
    leaf.height = 200;
    leaf.x = 25;
    outer.add(inner);
    inner.add(leaf);
    projection.update(leaf, leaf.getWorldTransform());
    // Outer [0,100] and inner [25,125] in leaf-local (leaf at world x=50):
    // [-50,50] ∩ [-25,75] = [-25,50], y [0,100].
    expect(projection.getElement('leaf')!.style.clipPath).toBe(
      'polygon(-25px 0px, 50px 0px, 50px 100px, -25px 100px)',
    );
  });

  it('collapses disjoint clippers to a zero-area polygon', () => {
    const outer = new ProbeNode('outer');
    outer.clipChildren = true;
    outer.width = 100;
    outer.height = 100;
    const inner = new ProbeNode('inner');
    inner.clipChildren = true;
    inner.width = 100;
    inner.height = 100;
    inner.x = 200;
    const leaf = new ProbeNode('leaf');
    leaf.width = 200;
    leaf.height = 200;
    leaf.x = -150;
    outer.add(inner);
    inner.add(leaf);
    projection.update(leaf, leaf.getWorldTransform());
    // Outer [0,100] and inner [200,300] in leaf-local (leaf at world x=50):
    // [-50,50] ∩ [150,250] is empty — fully clipped.
    expect(projection.getElement('leaf')!.style.clipPath).toBe(
      'polygon(0px 0px, 0px 0px, 0px 0px)',
    );
  });

  it('clips a lone distant clipper to an off-content region (renders nothing)', () => {
    const { child } = clippedTree();
    child.x = 500;
    projection.update(child, child.getWorldTransform());
    const el = projection.getElement('clipped')!;
    // Clipper [0,100] in child-local: [-500,-400]x[0,100] — no child content
    // ([0,200]x[0,200]) survives, so nothing renders, matching the hit-test.
    expect(el.style.clipPath).toBe('polygon(-500px 0px, -400px 0px, -400px 100px, -500px 100px)');
    const pts = parsePolygon(el.style.clipPath);
    for (const [lx, ly] of [
      [0, 0],
      [100, 10],
      [199, 199],
      [10, 100],
    ]) {
      expect(insideAllClippers(child, lx + 500, ly)).toBe(false);
      expect(insidePolygon(pts, lx, ly)).toBe(false);
    }
  });

  it('clears the clip when no clipper applies', () => {
    const { clipper, child } = clippedTree();
    projection.update(child, child.getWorldTransform());
    expect(projection.getElement('clipped')!.style.clipPath).not.toBe('');
    clipper.clipChildren = false;
    projection.update(child, child.getWorldTransform());
    expect(projection.getElement('clipped')!.style.clipPath).toBe('');
  });

  it('leaves unclipped nodes alone', () => {
    const node = new ProbeNode('plain');
    projection.update(node, IDENTITY);
    expect(projection.getElement('plain')!.style.clipPath).toBe('');
    expect(projection.getStats().clipWrites).toBe(0);
  });
});

describe('DOMProjection stable z-order across remounts (r6)', () => {
  let canvas: HTMLCanvasElement;
  let projection: DOMProjection;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    projection = new DOMProjection(canvas);
  });

  afterEach(() => {
    projection.dispose();
    canvas.remove();
    document.body.innerHTML = '';
  });

  const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

  it('restores the same z on remount, preserving relative paint order', () => {
    const a = new ProbeNode('z1');
    const b = new ProbeNode('z2');
    const c = new ProbeNode('z3');
    projection.update(a, IDENTITY);
    projection.update(b, IDENTITY);
    projection.update(c, IDENTITY);
    const za = projection.getElement('z1')!.style.zIndex;
    const zb = projection.getElement('z2')!.style.zIndex;
    const zc = projection.getElement('z3')!.style.zIndex;
    expect(Number(za)).toBeLessThan(Number(zb));
    expect(Number(zb)).toBeLessThan(Number(zc));
    // Unmount/remount reuses the pooled element but must NOT take a fresh
    // mount slot (which would float it above its later siblings).
    projection.unmount(a);
    projection.update(a, IDENTITY);
    expect(projection.getStats().poolHits).toBe(1);
    expect(projection.getElement('z1')!.style.zIndex).toBe(za);
    const order = ['z1', 'z2', 'z3'].map((id) => Number(projection.getElement(id)!.style.zIndex));
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });
});
