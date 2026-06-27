import { describe, it, expect } from 'vitest';
import type { IRenderer } from '@vecto-ui/core';
import { RichText } from '../src/RichText';

interface DrawCall {
  text: string;
  x: number;
  y: number;
  font: string;
  color: string;
}

/** A renderer that records every fillText call (ignores everything else). */
function recordingRenderer(): { r: IRenderer; calls: DrawCall[] } {
  const calls: DrawCall[] = [];
  const r = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'fillText')
          return (text: string, x: number, y: number, font: string, color: string) =>
            calls.push({ text, x, y, font, color });
        return () => {};
      },
    },
  ) as unknown as IRenderer;
  return { r, calls };
}

describe('RichText', () => {
  it('draws each run with its own color', () => {
    const { r, calls } = recordingRenderer();
    new RichText([
      { text: 'a', style: { color: '#f00' } },
      { text: 'b', style: { color: '#00f' } },
    ]).render(r);
    expect(calls.find((c) => c.text === 'a')?.color).toBe('#f00');
    expect(calls.find((c) => c.text === 'b')?.color).toBe('#00f');
  });

  it('encodes bold + italic into the per-glyph font shorthand', () => {
    const { r, calls } = recordingRenderer();
    new RichText([
      { text: 'x', style: { bold: true } },
      { text: 'y', style: { italic: true } },
    ]).render(r);
    expect(calls.find((c) => c.text === 'x')?.font).toContain('bold');
    expect(calls.find((c) => c.text === 'y')?.font).toContain('italic');
  });

  it('renders a larger run at its own size', () => {
    const { r, calls } = recordingRenderer();
    new RichText([{ text: 'H', style: { fontSize: 40 } }], { font: '16px sans-serif' }).render(r);
    expect(calls.find((c) => c.text === 'H')?.font).toContain('40px');
  });

  it('falls back to the base color when a run has none', () => {
    const { r, calls } = recordingRenderer();
    new RichText([{ text: 'z' }], { color: '#abcdef' }).render(r);
    expect(calls.find((c) => c.text === 'z')?.color).toBe('#abcdef');
  });

  it('exposes the concatenated text as its accessible name and sizes its box', () => {
    const rt = new RichText([{ text: 'Hello ' }, { text: 'world', style: { bold: true } }]);
    expect(rt.getA11yAttributes().label).toBe('Hello world');
    expect(rt.width).toBeGreaterThan(0);
    expect(rt.height).toBeGreaterThan(0);
  });

  it('does not throw rendering a multi-run, wrapped paragraph', () => {
    const { r } = recordingRenderer();
    const rt = new RichText(
      [
        { text: 'The ' },
        { text: 'quick brown', style: { bold: true, color: '#38bdf8' } },
        { text: ' fox jumps over the lazy dog', style: { italic: true } },
      ],
      { maxWidth: 80 },
    );
    expect(() => rt.render(r)).not.toThrow();
  });
});
