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
      // strokeWidth 0 means no inflation
      expect(bounds.x).toBe(-0); // 0/2 = 0, but negation gives -0
      expect(bounds.y).toBe(-0);
      expect(bounds.width).toBe(100);
      expect(bounds.height).toBe(50);
    });
  });
});
