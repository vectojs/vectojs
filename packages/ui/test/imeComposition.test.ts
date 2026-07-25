import { describe, it, expect } from 'vitest';
import { Input, TextArea } from '../src';

/**
 * Composing over a selection logically REPLACES that range, but the native
 * `<input>`/`<textarea>` keeps reporting the pre-composition
 * `selectionStart`/`selectionEnd` until the composition commits. Painting that
 * range would draw a stale highlight behind — and wider than — the composition
 * underline. While composing, the composition range is the active region.
 *
 * `TextArea` additionally never drew a composition underline at all, so a
 * multi-keystroke IME conversion had no in-canvas feedback.
 */
describe('IME composition over a selection', () => {
  /** Record the draw calls a component makes, in order. */
  const recorder = () => {
    const calls: string[] = [];
    const r = new Proxy(
      {},
      {
        get(_t, prop) {
          return (...args: unknown[]) => {
            if (prop === 'fill') calls.push(`fill:${String(args[0])}`);
            else if (prop === 'stroke') calls.push(`stroke:${String(args[0])}`);
            else calls.push(String(prop));
            return undefined;
          };
        },
      },
    ) as never;
    return { r, calls };
  };

  const SELECTION = 'rgba(56, 189, 248, 0.35)';

  describe('Input', () => {
    const makeInput = () => {
      const input = new Input({ value: 'hello world', width: 200 });
      input.selectionStart = 6;
      input.selectionEnd = 11; // "world" selected
      return input;
    };

    it('paints the selection highlight when not composing', () => {
      const input = makeInput();
      const { r, calls } = recorder();
      input.render(r);
      expect(calls.some((c) => c === `fill:${SELECTION}`)).toBe(true);
    });

    it('suppresses the stale selection highlight while composing', () => {
      const input = makeInput();
      // IME started over the selection; the element still reports 6..11.
      input.composition = { start: 6, length: 2 };
      const { r, calls } = recorder();
      input.render(r);
      expect(calls.some((c) => c === `fill:${SELECTION}`)).toBe(false);
    });

    it('still paints the selection for a zero-length composition', () => {
      const input = makeInput();
      // compositionstart fires with length 0 before any candidate text exists.
      input.composition = { start: 6, length: 0 };
      const { r, calls } = recorder();
      input.render(r);
      expect(calls.some((c) => c === `fill:${SELECTION}`)).toBe(true);
    });
  });

  describe('TextArea', () => {
    const makeArea = () => {
      const area = new TextArea({
        value: 'hello world',
        width: 200,
        height: 80,
      });
      area.selectionStart = 6;
      area.selectionEnd = 11;
      return area;
    };

    it('paints the selection highlight when not composing', () => {
      const area = makeArea();
      const { r, calls } = recorder();
      area.render(r);
      expect(calls.some((c) => c === `fill:${SELECTION}`)).toBe(true);
    });

    it('suppresses the stale selection highlight while composing', () => {
      const area = makeArea();
      area.composition = { start: 6, length: 2 };
      const { r, calls } = recorder();
      area.render(r);
      expect(calls.some((c) => c === `fill:${SELECTION}`)).toBe(false);
    });

    it('draws a composition underline (previously absent entirely)', () => {
      const plain = makeArea();
      const { r: r1, calls: without } = recorder();
      plain.render(r1);

      const composing = makeArea();
      composing.composition = { start: 6, length: 2 };
      const { r: r2, calls: with_ } = recorder();
      composing.render(r2);

      // Composing adds stroke work the non-composing render doesn't do.
      const strokes = (c: string[]) => c.filter((x) => x.startsWith('stroke:')).length;
      expect(strokes(with_)).toBeGreaterThan(strokes(without));
    });
  });
});
