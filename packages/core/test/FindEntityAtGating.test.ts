// @vitest-environment jsdom
// findEntityAt's JS hit walk (findHitRecursively, the permanent fallback used
// when no WASM hit grid is active) must respect visibility + input gating that a
// naive "isPointInside on every node" walk ignored: an opacity:0 subtree, a
// child clipped outside a clipChildren ancestor, and a disabled / pointerEvents:
// 'none' node are all NOT hit targets.
import { describe, it, expect } from 'vitest';
import { Scene, Entity, type Bounds, type A11yAttributes } from '../src/index';

HTMLCanvasElement.prototype.getContext = (() => null) as never;

/** An axis-aligned rectangle at its local origin; hit == inside its world box. */
class Rect extends Entity {
  public a11y: A11yAttributes = {};
  constructor(
    id: string,
    public width: number,
    public height: number,
  ) {
    super(id);
  }
  getBounds(): Bounds {
    return { x: 0, y: 0, width: this.width, height: this.height };
  }
  isPointInside(gx: number, gy: number): boolean {
    const local = this.worldToLocal(gx, gy);
    if (!local) return false;
    return local.x >= 0 && local.x <= this.width && local.y >= 0 && local.y <= this.height;
  }
  getA11yAttributes(): A11yAttributes {
    return this.a11y;
  }
  render(): void {}
}

function makeScene(): Scene {
  const canvas = document.createElement('canvas');
  return new Scene(canvas);
}

describe('findEntityAt JS walk — visibility + input gating', () => {
  it('hits a plain opaque rect', () => {
    const scene = makeScene();
    const r = new Rect('r', 100, 100);
    scene.add(r);
    expect(scene.findEntityAt(50, 50)?.id).toBe('r');
  });

  it('does NOT hit an invisible (opacity 0) node', () => {
    const scene = makeScene();
    const r = new Rect('r', 100, 100);
    r.opacity = 0;
    scene.add(r);
    expect(scene.findEntityAt(50, 50)).toBeNull();
  });

  it('does NOT hit anything inside an invisible subtree', () => {
    const scene = makeScene();
    const parent = new Rect('parent', 200, 200);
    const child = new Rect('child', 50, 50);
    child.setPosition(10, 10);
    parent.add(child);
    parent.opacity = 0; // whole subtree invisible
    scene.add(parent);
    expect(scene.findEntityAt(20, 20)).toBeNull();
  });

  it('does NOT hit a child clipped outside its clipChildren ancestor', () => {
    const scene = makeScene();
    const clip = new Rect('clip', 100, 100);
    clip.clipChildren = true;
    const child = new Rect('child', 40, 40);
    child.setPosition(200, 200); // entirely outside the 100×100 clip box
    clip.add(child);
    scene.add(clip);
    // The point is inside the child's own box…
    expect((child as Rect).isPointInside(220, 220)).toBe(true);
    // …but the child is clipped away, so no hit there (only the clip box hits).
    expect(scene.findEntityAt(220, 220)).toBeNull();
  });

  it('still hits a child that is inside the clipChildren ancestor', () => {
    const scene = makeScene();
    const clip = new Rect('clip', 100, 100);
    clip.clipChildren = true;
    const child = new Rect('child', 40, 40);
    child.setPosition(10, 10); // inside the clip box
    clip.add(child);
    scene.add(clip);
    expect(scene.findEntityAt(20, 20)?.id).toBe('child');
  });

  it('does NOT hit a disabled node, but still hits siblings/children under it', () => {
    const scene = makeScene();
    const disabled = new Rect('disabled', 100, 100);
    disabled.a11y = { disabled: true };
    scene.add(disabled);
    expect(scene.findEntityAt(50, 50)).toBeNull();

    // A hittable child under a disabled container is still reachable.
    const child = new Rect('child', 30, 30);
    child.setPosition(10, 10);
    disabled.add(child);
    expect(scene.findEntityAt(20, 20)?.id).toBe('child');
  });

  it("does NOT hit a pointerEvents:'none' node", () => {
    const scene = makeScene();
    const r = new Rect('r', 100, 100);
    r.a11y = { pointerEvents: 'none' };
    scene.add(r);
    expect(scene.findEntityAt(50, 50)).toBeNull();
  });

  it('returns the top-most (last-drawn) hit among overlapping siblings', () => {
    const scene = makeScene();
    const under = new Rect('under', 100, 100);
    const over = new Rect('over', 100, 100);
    scene.add(under);
    scene.add(over); // added later = drawn on top
    expect(scene.findEntityAt(50, 50)?.id).toBe('over');
  });
});
