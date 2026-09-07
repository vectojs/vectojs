import { describe, it, expect } from 'vitest';
import { affineToMatrix3d } from '../src/matrix';

describe('affineToMatrix3d (RFC §5 rule 1)', () => {
  it('embeds the identity affine', () => {
    expect(affineToMatrix3d({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })).toBe(
      'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)',
    );
  });

  it('places translation in the fourth column', () => {
    expect(affineToMatrix3d({ a: 1, b: 0, c: 0, d: 1, e: 30, f: 40 })).toBe(
      'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 30, 40, 0, 1)',
    );
  });

  it('keeps rotation selectable (90° stays exact)', () => {
    expect(affineToMatrix3d({ a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 })).toBe(
      'matrix3d(0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)',
    );
  });

  it('embeds non-uniform scale', () => {
    expect(affineToMatrix3d({ a: 2, b: 0, c: 0, d: 3, e: 5, f: 7 })).toBe(
      'matrix3d(2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, 5, 7, 0, 1)',
    );
  });
});
