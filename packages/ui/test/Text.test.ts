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

  it('justify projection emits positioned per-word runs whose x matches the glyphs', () => {
    const t = new Text('aa aa aa aa aa', {
      maxWidth: 80,
      textAlign: 'justify',
    });
    const proj = t.getContentProjection()!;
    const line0 = proj.lines![0];
    // Positioned runs carry x/width so the DOM selection box overlaps the
    // widened canvas spacing (the selection-drift fix).
    expect(line0.runs && line0.runs.length).toBeGreaterThan(1);
    expect(line0.runs!.every((r) => typeof r.x === 'number' && typeof r.width === 'number')).toBe(
      true,
    );
    // Runs are in visual order, left to right, and the last word reaches near
    // maxWidth (justified flush) — the same geometry the canvas renders.
    const xs = line0.runs!.map((r) => r.x!);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    const last = line0.runs!.at(-1)!;
    expect(last.x! + last.width!).toBeCloseTo(80, 0);

    // The paragraph-final line is NOT stretched: its first word sits at the
    // left origin and it does NOT reach maxWidth (ragged), even though it still
    // carries positioned runs (their x is just the natural, un-widened layout).
    const lastLine = proj.lines!.at(-1)!;
    const lastRuns = lastLine.runs!;
    expect(lastRuns[0].x).toBeCloseTo(0, 0);
    const end = lastRuns.at(-1)!;
    expect(end.x! + end.width!).toBeLessThan(80);
  });

  it('left-aligned projection has no positioned runs (natural flow)', () => {
    const t = new Text('aa aa aa aa aa', { maxWidth: 80 });
    for (const line of t.getContentProjection()!.lines!) {
      expect(line.runs).toBeUndefined();
    }
  });
});

describe('Text bidi (RTL) selection projection', () => {
  // Hebrew Shin+Lamed (RTL, no shaping). No DOM here → engine 0.5em fallback,
  // but RTL reorder + right-align are engine-driven and deterministic.
  const SHIN = '\u05E9';
  const LAMED = '\u05DC';

  it('emits per-glyph positioned runs in LOGICAL order with VISUAL x', () => {
    // maxWidth 80; two RTL glyphs (8px each at 16px font) right-align to the edge.
    const t = new Text(SHIN + LAMED, { maxWidth: 80, font: '16px sans-serif' });
    const proj = t.getContentProjection()!;
    const runs = proj.lines![0].runs!;
    expect(runs.length).toBe(2);
    // Logical order: Shin (source 0) first, Lamed (source 1) second — so copy
    // and screen-reader order stay correct.
    expect(runs[0].text).toBe(SHIN);
    expect(runs[1].text).toBe(LAMED);
    // Every run carries an explicit visual x + width (positioned carrier).
    expect(runs.every((r) => typeof r.x === 'number' && typeof r.width === 'number')).toBe(true);
    // Visual order is REVERSED: Shin (logical first) sits to the RIGHT of Lamed.
    expect(runs[0].x!).toBeGreaterThan(runs[1].x!);
    // Right-aligned: the rightmost glyph (Shin) ends flush at maxWidth.
    expect(runs[0].x! + runs[0].width!).toBeCloseTo(80, 0);
  });

  it('LTR text keeps natural flow (no positioned runs)', () => {
    const t = new Text('ab', { maxWidth: 80 });
    expect(t.getContentProjection()!.lines![0].runs).toBeUndefined();
  });

  it('Arabic runs carry LOGICAL source chars, not shaped presentation forms', () => {
    // Arabic "كتب" — the engine shapes to contextual forms (U+FExx) on canvas,
    // but the projection must expose the original base letters for copy / AT.
    const src = '\u0643\u062A\u0628'; // ك ت ب
    const t = new Text(src, { maxWidth: 200, font: '18px sans-serif' });
    const runs = t.getContentProjection()!.lines![0].runs!;
    const joined = runs.map((r) => r.text).join('');
    // Every projected char is a base Arabic letter (U+0600–06FF), never a
    // presentation form (U+FB50–FEFF) — the bug the RTL screenshot probe caught.
    for (const ch of joined) {
      const cp = ch.codePointAt(0)!;
      expect(cp).toBeGreaterThanOrEqual(0x0600);
      expect(cp).toBeLessThanOrEqual(0x06ff);
    }
    // Runs are in logical order, so the concatenation round-trips to the source.
    expect(joined).toBe(src);
  });
});
