import { describe, it, expect, vi } from 'vitest';
import type { IRenderer } from '@vectojs/core';
import { Text } from '../src/Text';

/** Records every fillText call (Text draws one call per visual line). */
function recordingRenderer(): { r: IRenderer; lines: string[] } {
  const lines: string[] = [];
  const r = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'fillText') return (text: string) => lines.push(text);
        return () => {};
      },
    },
  ) as unknown as IRenderer;
  return { r, lines };
}

describe('Text streaming (流式打字机)', () => {
  it('append() grows the content and the accessible name', () => {
    const t = new Text('Hello');
    t.append(' world');
    expect(t.text).toBe('Hello world');
    expect(t.getA11yAttributes().label).toBe('Hello world');
  });

  it('append() across a newline yields two rendered lines', () => {
    const { r, lines } = recordingRenderer();
    const t = new Text('line1', { maxWidth: 1000 });
    t.append('\nline2');
    t.render(r);
    expect(lines).toEqual(['line1', 'line2']);
  });

  it('wakes an on-demand scene after a streamed append', () => {
    const t = new Text('first');
    const markDirty = vi.fn();
    (t as unknown as { _scene: { markDirty: () => void } })._scene = {
      markDirty,
    };
    t.append(' second');
    expect(markDirty).toHaveBeenCalledOnce();
  });

  it('exposes its text for DOM content projection', () => {
    const t = new Text('Findable ui text', { font: '18px sans-serif' });
    const proj = t.getContentProjection()!;
    expect(proj.text).toBe('Findable ui text');
    expect(proj.font).toBe('18px sans-serif');
  });
});

/** Records fillText with coordinates (the glyph-accurate path draws per glyph). */
function xyRecorder(): {
  r: IRenderer;
  calls: Array<{ text: string; x: number; y: number }>;
} {
  const calls: Array<{ text: string; x: number; y: number }> = [];
  const r = new Proxy({} as IRenderer, {
    get(_t, prop) {
      if (prop === 'fillText')
        return (text: string, x: number, y: number) => calls.push({ text, x, y });
      return () => {};
    },
  });
  return { r, calls };
}

describe('Text alignment & hyphenation', () => {
  // No DOM here, so the engine uses its portable 0.5em fallback: each glyph is
  // fontSize*0.5 = 8px at the default 16px font, making the geometry deterministic.
  it('left-aligned (default) draws one fillText per line, not per glyph', () => {
    const { r, calls } = xyRecorder();
    new Text('aa aa aa aa aa', { maxWidth: 80 }).render(r);
    // Fast path: each call carries a whole line string, and all start at x=0.
    expect(calls.every((c) => c.x === 0)).toBe(true);
    expect(calls.some((c) => c.text.length > 1)).toBe(true);
  });

  it('justify draws per glyph and stretches a wrapped line flush to maxWidth', () => {
    const { r, calls } = xyRecorder();
    new Text('aa aa aa aa aa', { maxWidth: 80, textAlign: 'justify' }).render(r);
    // Per-glyph path: every call is a single character.
    expect(calls.every((c) => c.text.length === 1)).toBe(true);
    const y0 = Math.min(...calls.map((c) => c.y));
    const line0 = calls.filter((c) => c.y === y0 && c.text.trim());
    const right = Math.max(...line0.map((c) => c.x + 8));
    expect(right).toBeCloseTo(80, 0); // first line justified flush to maxWidth
  });

  it('justify leaves the last line ragged', () => {
    const { r, calls } = xyRecorder();
    new Text('aa aa aa aa aa', { maxWidth: 80, textAlign: 'justify' }).render(r);
    const yMax = Math.max(...calls.map((c) => c.y));
    const lastLine = calls.filter((c) => c.y === yMax && c.text.trim());
    const right = Math.max(...lastLine.map((c) => c.x + 8));
    expect(right).toBeLessThan(80);
  });

  it('hyphenate breaks an overflowing word with a visible hyphen', () => {
    const { r, calls } = xyRecorder();
    new Text('hyphenation', {
      maxWidth: 48,
      hyphenate: (w) => (w.length > 3 ? [w.slice(0, 3), w.slice(3)] : [w]),
    }).render(r);
    expect(calls.some((c) => c.text === '-')).toBe(true);
  });

  it('content projection still returns the original text on the justify path', () => {
    const t = new Text('aa aa aa aa aa', {
      maxWidth: 80,
      textAlign: 'justify',
    });
    expect(t.getContentProjection()!.text).toBe('aa aa aa aa aa');
  });
});
