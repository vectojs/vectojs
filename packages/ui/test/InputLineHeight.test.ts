// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Input } from '../src/Input';
import { fontSizePx } from '../src/measure';

/**
 * The projected element is the real editing surface, so its `line-height` has to
 * stay usable at any box height: a line box shorter than the font clips painted
 * glyphs AND misplaces the caret/selection against what the canvas draws.
 */

function projectedLineHeight(input: Input): number {
  const style = input.getA11yAttributes().textInputStyle;
  if (!style) throw new Error('Input did not project a textInputStyle');
  return style.lineHeight;
}

describe('Input projected line-height', () => {
  it('never drops below the font size on a compact input', () => {
    // Regression: `height - 2 * padding` with the default `padding: 10` produced
    // an 8px line box for this exact configuration, rendering `100` as `1QQ`.
    const input = new Input({
      width: 80,
      height: 28,
      font: '13px monospace',
      value: '100',
    });

    expect(projectedLineHeight(input)).toBe(13);
    expect(projectedLineHeight(input)).toBeGreaterThanOrEqual(fontSizePx('13px monospace'));
  });

  it('stays at the font size across every height that used to crush it', () => {
    // Default padding puts the crush threshold at height < 33 for a 13px font.
    for (const height of [20, 24, 28, 32]) {
      const input = new Input({ width: 80, height, font: '13px monospace', value: '100' });
      expect(projectedLineHeight(input)).toBe(13);
    }
  });

  it('still fills the inner box when the box is tall enough', () => {
    // The original intent is preserved above the threshold: a single line centred
    // in its inner height, not pinned to the font size.
    const input = new Input({ width: 120, height: 40, font: '13px monospace', value: '100' });
    expect(projectedLineHeight(input)).toBe(20);

    const tall = new Input({ width: 120, height: 60, font: '13px monospace', value: '100' });
    expect(projectedLineHeight(tall)).toBe(40);
  });

  it('scales with the font rather than assuming 13px', () => {
    const large = new Input({ width: 200, height: 28, font: '24px sans-serif', value: 'abc' });
    expect(projectedLineHeight(large)).toBe(24);

    const small = new Input({ width: 60, height: 14, font: '9px monospace', value: '7' });
    expect(projectedLineHeight(small)).toBe(9);
  });

  it('honours an explicit padding without going under the font', () => {
    const padded = new Input({
      width: 120,
      height: 28,
      padding: 2,
      font: '13px monospace',
      value: '100',
    });
    // 28 - 4 = 24, comfortably over the font, so the box wins.
    expect(projectedLineHeight(padded)).toBe(24);
  });
});
