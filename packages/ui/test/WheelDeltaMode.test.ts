/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';

/**
 * Verify deltaMode conversion logic used in scroll widgets.
 * Extracted from ScrollView/Table/Tree/VirtualList/Tabs wheel handlers.
 */
describe('WheelEvent deltaMode conversion', () => {
  function convertDelta(deltaY: number, deltaMode: number, viewportHeight: number): number {
    if (deltaMode === 1) return deltaY * 16; // line mode (~16px per line)
    if (deltaMode === 2) return deltaY * viewportHeight; // page mode
    return deltaY; // pixel mode (0)
  }

  it('leaves pixel-mode delta unchanged (deltaMode 0)', () => {
    expect(convertDelta(100, 0, 600)).toBe(100);
    expect(convertDelta(-50, 0, 600)).toBe(-50);
  });

  it('converts line-mode delta to ~16px per line (deltaMode 1)', () => {
    expect(convertDelta(3, 1, 600)).toBe(48); // 3 lines × 16px
    expect(convertDelta(-5, 1, 600)).toBe(-80); // -5 lines × 16px
  });

  it('converts page-mode delta to viewport-height units (deltaMode 2)', () => {
    expect(convertDelta(1, 2, 600)).toBe(600); // 1 page = viewport height
    expect(convertDelta(-1, 2, 800)).toBe(-800);
    expect(convertDelta(0.5, 2, 600)).toBe(300); // half page
  });

  it('handles zero delta in any mode', () => {
    expect(convertDelta(0, 0, 600)).toBe(0);
    expect(convertDelta(0, 1, 600)).toBe(0);
    expect(convertDelta(0, 2, 600)).toBe(0);
  });
});
