// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { SplineEntity, Entity, type SplineDocument } from '../src/index';

class Group extends Entity {
  isPointInside() {
    return false;
  }
  render() {}
}

// An "L": one segment along y=0 (x 0→100) and one along x=0 (y 0→100).
// AABB is 0..100 × 0..100 but the interior (e.g. (90,90)) is far from both curves.
const L_DOC: SplineDocument = {
  type: 'Spline',
  equations: [
    {
      color_rgb: [1, 1, 1],
      data: [
        { start_t: 0, end_t: 1, x_poly: [0, 100, 0, 0], y_poly: [0, 0, 0, 0] },
        { start_t: 0, end_t: 1, x_poly: [0, 0, 0, 0], y_poly: [0, 100, 0, 0] },
      ],
    },
  ],
  bounding_box: [0, 0, 100, 100],
};

describe('Entity.getWorldScale', () => {
  it('accumulates own and ancestor scale, ignoring the root', () => {
    const parent = new Group('p');
    parent.scaleX = 2;
    parent.scaleY = 3;
    const child = new Group('c');
    child.scaleX = 4;
    child.scaleY = 5;
    parent.add(child);
    expect(child.getWorldScale()).toEqual({ x: 8, y: 15 });
  });
});

describe('SplineEntity — curve-accurate hit-testing', () => {
  it('hits near a curve and misses inside the AABB but away from any curve', () => {
    const s = new SplineEntity(L_DOC, { lineWidth: 4 }); // tolerance = lineWidth/2 = 2
    s.setPosition(0, 0);

    expect(s.isPointInside(50, 1)).toBe(true); // 1px from the y=0 segment ≤ 2
    expect(s.isPointInside(50, 5)).toBe(false); // 5px away > 2
    expect(s.isPointInside(90, 90)).toBe(false); // inside AABB, far from both curves
    expect(s.isPointInside(200, 200)).toBe(false); // outside AABB entirely
  });

  it('maps world→local through the entity scale before testing the curve', () => {
    const s = new SplineEntity(L_DOC, { lineWidth: 4 });
    s.setPosition(0, 0);
    s.scaleX = 2;
    s.scaleY = 2;
    // World (100, 2) → local (50, 1): near the curve despite the 2× scale.
    expect(s.isPointInside(100, 2)).toBe(true);
    // World (180, 180) → local (90, 90): inside AABB, far from curves.
    expect(s.isPointInside(180, 180)).toBe(false);
  });

  it('hitTest:"aabb" keeps the coarse bounding-box behavior', () => {
    const s = new SplineEntity(L_DOC, { lineWidth: 4, hitTest: 'aabb' });
    s.setPosition(0, 0);
    expect(s.isPointInside(90, 90)).toBe(true); // anywhere in the AABB hits
  });

  it('honors an extra hitTolerance', () => {
    const s = new SplineEntity(L_DOC, { lineWidth: 2, hitTolerance: 5 }); // tol = 1 + 5 = 6
    s.setPosition(0, 0);
    expect(s.isPointInside(50, 5)).toBe(true); // 5 ≤ 6
    expect(s.isPointInside(50, 8)).toBe(false); // 8 > 6
  });
});
