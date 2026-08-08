/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { Circle } from '../src/components/Circle';
import { Rect } from '../src/components/Rect';

describe('Circle and Rect getBounds() stroke inflation', () => {
  describe('Circle', () => {
    it('returns radius-only bounds when no stroke', () => {
      const circle = new Circle({ radius: 50, fill: '#f00', stroke: null });
      const bounds = circle.getBounds();
      expect(bounds.x).toBe(-50);
      expect(bounds.y).toBe(-50);
      expect(bounds.width).toBe(100);
      expect(bounds.height).toBe(100);
    });

    it('inflates bounds by strokeWidth/2 when stroke is present', () => {
      const circle = new Circle({
        radius: 50,
        fill: '#f00',
        stroke: '#000',
        strokeWidth: 10,
      });
      const bounds = circle.getBounds();
      // Full radius = 50 + 10/2 = 55
      expect(bounds.x).toBe(-55);
      expect(bounds.y).toBe(-55);
      expect(bounds.width).toBe(110);
      expect(bounds.height).toBe(110);
    });

    it('handles thin strokes correctly', () => {
      const circle = new Circle({
        radius: 100,
        fill: null,
        stroke: '#000',
        strokeWidth: 2,
      });
      const bounds = circle.getBounds();
      // Full radius = 100 + 2/2 = 101
      expect(bounds.x).toBe(-101);
      expect(bounds.y).toBe(-101);
      expect(bounds.width).toBe(202);
      expect(bounds.height).toBe(202);
    });
  });

  describe('Rect', () => {
    it('returns exact dimensions when no stroke', () => {
      const rect = new Rect({
        width: 100,
        height: 50,
        fill: '#f00',
        stroke: null,
      });
      const bounds = rect.getBounds();
      expect(bounds.x).toBeCloseTo(0);
      expect(bounds.y).toBeCloseTo(0);
      expect(bounds.width).toBe(100);
      expect(bounds.height).toBe(50);
    });

    it('inflates bounds by strokeWidth/2 when stroke is present', () => {
      const rect = new Rect({
        width: 100,
        height: 50,
        fill: '#f00',
        stroke: '#000',
        strokeWidth: 10,
      });
      const bounds = rect.getBounds();
      // Inflation = 10/2 = 5 on each side
      expect(bounds.x).toBe(-5);
      expect(bounds.y).toBe(-5);
      expect(bounds.width).toBe(110); // 100 + 5*2
      expect(bounds.height).toBe(60); // 50 + 5*2
    });

    it('handles thin strokes correctly', () => {
      const rect = new Rect({
        width: 200,
        height: 100,
        fill: null,
        stroke: '#000',
        strokeWidth: 2,
      });
      const bounds = rect.getBounds();
      // Inflation = 2/2 = 1 on each side
      expect(bounds.x).toBe(-1);
      expect(bounds.y).toBe(-1);
      expect(bounds.width).toBe(202);
      expect(bounds.height).toBe(102);
    });

    it('handles zero strokeWidth edge case', () => {
      const rect = new Rect({
        width: 100,
        height: 50,
        fill: '#f00',
        stroke: '#000',
        strokeWidth: 0,
      });
      const bounds = rect.getBounds();
      // strokeWidth 0 means no inflation, and the origin must be a positive zero:
      // `toBe` is Object.is, which separates -0 from 0.
      expect(Object.is(bounds.x, 0)).toBe(true);
      expect(Object.is(bounds.y, 0)).toBe(true);
      expect(bounds.width).toBe(100);
      expect(bounds.height).toBe(50);
    });

    it('returns a positive zero origin when unstroked (never -0)', () => {
      // Regression: `x: -inflation` yielded -0 for every unstroked rect. `-0 === 0`
      // is true, so nothing crashed, but `Object.is(-0, 0)` is false — a
      // `toEqual({ x: 0, … })` assertion fails and any consumer that
      // identity-compares an origin sees a different value than before the
      // inflation change. The unstroked result must stay byte-identical.
      const bounds = new Rect({
        width: 10,
        height: 10,
        fill: '#f00',
      }).getBounds();
      expect(Object.is(bounds.x, -0)).toBe(false);
      expect(Object.is(bounds.y, -0)).toBe(false);
      expect(bounds).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    });

    it('Circle with radius 0 and no stroke also returns a positive zero origin', () => {
      const bounds = new Circle({ radius: 0, fill: '#f00' }).getBounds();
      expect(Object.is(bounds.x, -0)).toBe(false);
      expect(Object.is(bounds.y, -0)).toBe(false);
      expect(bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    });
  });
});
