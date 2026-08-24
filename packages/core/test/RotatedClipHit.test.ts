// @vitest-environment jsdom
// The JS recursive hit walk must clip against a clipChildren ancestor's EXACT
// (rotation-aware) local rect, not its world AABB: rendering clips to the
// rotated rect, and the WASM flat gate always tested the exact local rect. With
// a rotated clipper the two paths used to disagree — a point in the AABB corner
// outside the true rect was a JS hit but never a WASM hit (#680).
import { describe, it, expect } from 'vitest';
import { Scene, Entity, type Bounds, type A11yAttributes } from '../src/index';

HTMLCanvasElement.prototype.getContext = (() => null) as never;

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

describe('rotated clipChildren hit parity', () => {
  // Container 100x100 at origin rotated +45deg (about its top-left): its exact
  // footprint is the diamond with corners (0,0), (70.71,70.71), (0,141.42),
  // (-70.71,70.71); its world AABB is [-70.71,70.71] x [0,141.42].
  //
  // `clipped` sits at container-local [-30..0] x [40..70] — entirely OUTSIDE
  // the exact rect (its local x <= 0) yet its world quad spans into the AABB's
  // left corner region. World point (-49.5, 28.28) is inside `clipped` and
  // inside the AABB, but outside the exact rect.
  //
  // `inner` sits at container-local [10..40]^2, fully inside the exact rect;
  // its world center is (0, 35.36).
  function buildRotatedScene(): {
    scene: Scene;
    clippedPoint: [number, number];
    innerPoint: [number, number];
  } {
    const scene = makeScene();
    const clip = new Rect('clip', 100, 100);
    clip.clipChildren = true;
    clip.rotation = Math.PI / 4;

    const clipped = new Rect('clipped', 30, 30);
    clipped.x = -30;
    clipped.y = 40;
    clip.add(clipped);

    const inner = new Rect('inner', 30, 30);
    inner.x = 10;
    inner.y = 10;
    clip.add(inner);

    scene.add(clip);
    return { scene, clippedPoint: [-49.5, 28.28], innerPoint: [0, 35.36] };
  }

  it('JS walk rejects a point inside the AABB corner but outside the exact rotated rect', () => {
    const { scene, clippedPoint } = buildRotatedScene();
    expect(scene.findEntityAt(clippedPoint[0], clippedPoint[1])?.id ?? null).toBeNull();
  });

  it('JS walk still hits an unclipped child of the same rotated container', () => {
    const { scene, innerPoint } = buildRotatedScene();
    expect(scene.findEntityAt(innerPoint[0], innerPoint[1])?.id).toBe('inner');
  });
});
