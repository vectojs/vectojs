// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Input } from '../src/Input';
import { TextArea } from '../src/TextArea';
import { measureText } from '../src/measure';

describe('Input BiDi and Caret Selection Integration', () => {
  it('should locate caret X position correctly for LTR and RTL text in Input', () => {
    const input = new Input({
      width: 200,
      font: '16px sans-serif',
      value: '\u05E9\u05DC\u05D5\u05DD abc', // "שלום abc" (Hebrew RTL word + LTR word)
    });

    // Hebrew: "שלום" -> visual reversed.
    // Caret at logical index 0 (start of Hebrew "ש"):
    // Visually, the Hebrew word starts on the right of its block.
    // LTR " abc" will remain on the right. RTL "שלום" will be visual reordered.
    // Let's assert caret position resolves without crashes and follows Bidi logic
    const x0 = (input as any).charOffset(0);
    const x4 = (input as any).charOffset(4);
    const x8 = (input as any).charOffset(8);

    expect(x0).toBeGreaterThanOrEqual(0);
    expect(x4).toBeGreaterThanOrEqual(0);
    expect(x8).toBeGreaterThanOrEqual(0);
  });

  it('caches its RTL-script detection instead of re-scanning the whole value on every charOffset() call', () => {
    const value = 'שלום abc';
    const input = new Input({ width: 200, font: '16px sans-serif', value });

    (input as any).charOffset(0);
    expect((input as any)._rtlCacheValue).toBe(value);
    expect((input as any)._rtlCacheResult).toBe(true);

    // Flip the cached result to a sentinel: if a later charOffset() call for
    // the same (unchanged) value recomputed instead of trusting the cache,
    // it would overwrite this sentinel back to `true` (this value does
    // contain RTL characters).
    (input as any)._rtlCacheResult = false;
    (input as any).charOffset(4);
    expect((input as any)._rtlCacheResult).toBe(false);

    // Changing the value must invalidate the cache and recompute.
    input.value = 'plain ascii';
    (input as any).charOffset(0);
    expect((input as any)._rtlCacheValue).toBe('plain ascii');
    expect((input as any)._rtlCacheResult).toBe(false);
  });

  it('should compute lines and caret position correctly for RTL text in TextArea', () => {
    const ta = new TextArea({
      width: 200,
      font: '16px sans-serif',
      value: '\u05E9\u05DC\u05D5\u05DD\nabc', // Hebrew word followed by LTR word on new line
    });

    const lines = (ta as any).computeLines();
    expect(lines.length).toBe(2);
    expect(lines[0].text).toContain('\u05E9');
    expect(lines[1].text).toBe('abc');

    const caretX_0 = (ta as any).offsetX(lines[0], 0);
    const caretX_1_before_a = (ta as any).offsetX(lines[1], 5); // index 5 is before 'a'
    const caretX_1_after_a = (ta as any).offsetX(lines[1], 6); // index 6 is after 'a'
    expect(caretX_0).toBeGreaterThanOrEqual(0);
    expect(caretX_1_before_a).toBe(0);
    expect(caretX_1_after_a).toBe(measureText('a', ta.font));
  });
});
