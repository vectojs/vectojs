import { describe, it, expect, vi } from 'vitest';
import type { IRenderer } from '@vectojs/core';
import { BidiResolver } from '@vectojs/text';
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

  it('justify projection anchors at x=0 (engine owns placement, no extra shift)', () => {
    // Guards the center/right work against double-shifting the engine-aligned
    // paths: justified lines keep line.x = 0 and their first word at x = 0.
    const t = new Text('aa aa aa aa aa', { maxWidth: 80, textAlign: 'justify' });
    const line0 = t.getContentProjection()!.lines![0];
    expect(line0.x).toBe(0);
    expect(line0.runs![0].x).toBeCloseTo(0, 0);
  });
});

describe('Text horizontal align (center / right)', () => {
  // No DOM here, so the layout engine AND measureText share the portable
  // 0.5em-per-char fallback (8px per char at the default 16px font): every
  // offset below is exact arithmetic — (maxWidth − lineWidth) × factor — not
  // an approximation of a real font.
  it('centers a single line at (maxWidth − lineWidth) / 2', () => {
    const { r, calls } = xyRecorder();
    // 'ab' paints 16px wide in a maxWidth of 80 → slack 64 → offset 32.
    new Text('ab', { maxWidth: 80, textAlign: 'center' }).render(r);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ text: 'ab', x: 32, y: 0.8 * 20 });
  });

  it('right-aligns a single line flush to maxWidth', () => {
    const { r, calls } = xyRecorder();
    // Right edge lands exactly at maxWidth: offset 80 − 16 = 64.
    new Text('ab', { maxWidth: 80, textAlign: 'right' }).render(r);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ text: 'ab', x: 64, y: 0.8 * 20 });
  });

  it('computes the offset PER WRAPPED LINE, not once for the block', () => {
    // Wraps into 'aa aa aa ' (trimmed extent 8 chars = 64px; the wrap-point
    // trailing space hangs) + 'aa aa' (5 chars = 40px): distinct slack per line
    // → offsets (80−64)/2 = 8 and (80−40)/2 = 20.
    const t = new Text('aa aa aa aa aa', { maxWidth: 80, textAlign: 'center' });
    const proj = t.getContentProjection()!;
    expect(proj.lines!.map((l) => l.text)).toEqual(['aa aa aa ', 'aa aa']);
    expect(proj.lines![0].x).toBeCloseTo(8, 6);
    expect(proj.lines![1].x).toBeCloseTo(20, 6);
    // The fast path paints exactly the projected origins.
    const { r, calls } = xyRecorder();
    t.render(r);
    expect(calls.map((c) => c.x)).toEqual([8, 20]);
    expect(calls.map((c) => c.y)).toEqual([16, 36]);
  });

  it('hangs the wrap-point trailing space like CSS text-align does', () => {
    // The retained trailing space paints no ink and must not eat slack:
    // centered ink stays at true center, right-aligned ink reaches the edge.
    const { r, calls } = xyRecorder();
    new Text('aa aa aa aa aa', { maxWidth: 80, textAlign: 'center' }).render(r);
    // Ink extents are the TRIMMED widths: 8..72 (center 40 ✓) and 20..60.
    expect(calls.map((c) => c.x)).toEqual([8, 20]);
    expect(calls[0]!.text).toBe('aa aa aa ');
  });

  it('right-align wraps each line flush to the same right edge', () => {
    const { r, calls } = xyRecorder();
    new Text('aa aa aa aa aa', { maxWidth: 80, textAlign: 'right' }).render(r);
    // 64px trimmed line at x=16 and 40px line at x=40 → ink ends exactly at 80.
    expect(calls.map((c) => c.x)).toEqual([16, 40]);
    expect(calls.every((c) => c.x + c.text.trimEnd().length * 8 === 80)).toBe(true);
  });

  it('carries ONE positioned run per aligned line so selection tracks glyphs', () => {
    const t = new Text('aa aa aa aa aa', { maxWidth: 80, textAlign: 'center' });
    const line0 = t.getContentProjection()!.lines![0];
    expect(line0.runs).toHaveLength(1);
    const [run] = line0.runs!;
    // Anchored at the trimmed-extent offset (the paint origin), but the box
    // covers the UNTRIMMED characters so copy's trailing space selects too.
    expect(run.text).toBe('aa aa aa ');
    expect(run.x).toBeCloseTo(8, 6);
    expect(run.width).toBeCloseTo(72, 6);
    expect(run.font).toContain('16px');
  });

  it('default (and explicit left) stays byte-parity: x=0, no runs, natural carriers', () => {
    const implicit = new Text('aa aa aa aa aa', { maxWidth: 80 });
    const explicit = new Text('aa aa aa aa aa', { maxWidth: 80, textAlign: 'left' });
    const { r, calls } = xyRecorder();
    implicit.render(r);
    expect(calls.every((c) => c.x === 0)).toBe(true);
    // Unset option and 'left' project identically — no run/carrier regression.
    expect(implicit.getContentProjection()!.lines).toEqual(explicit.getContentProjection()!.lines);
    for (const line of implicit.getContentProjection()!.lines!) {
      expect(line.runs).toBeUndefined();
      expect(line.perGraphemeCarriers).toBe(true);
      expect(line.x).toBe(0);
    }
  });

  it('without maxWidth there is no slack, so center/right degenerate to left', () => {
    const { r, calls } = xyRecorder();
    new Text('aa\nbb', { textAlign: 'center' }).render(r);
    expect(calls.every((c) => c.x === 0)).toBe(true);
  });

  it('setTextAlign switches alignment at runtime, both directions', () => {
    const t = new Text('ab', { maxWidth: 80 });
    t.setTextAlign('right');
    const right = xyRecorder();
    t.render(right.r);
    expect(right.calls[0]!.x).toBe(64);

    t.setTextAlign('left');
    const left = xyRecorder();
    t.render(left.r);
    expect(left.calls[0]!.x).toBe(0);
  });
});

describe('Text bidi (RTL) selection projection', () => {
  // Hebrew Shin+Lamed (RTL, no shaping). No DOM here → engine 0.5em fallback,
  // but RTL reorder + right-align are engine-driven and deterministic.
  const SHIN = '\u05E9';
  const LAMED = '\u05DC';

  it('projects the bidi line as a single logical string at the visual origin', () => {
    // maxWidth 80; two RTL glyphs (8px each at 16px font) right-align, so the
    // line's visual origin is shifted right (not 0). The projection keeps ONE
    // natural-flow line (browser does bidi → correct caret mapping) anchored at
    // that origin so its selection box overlaps the right-aligned glyphs.
    const t = new Text(SHIN + LAMED, { maxWidth: 80, font: '16px sans-serif' });
    const line0 = t.getContentProjection()!.lines![0];
    // No per-glyph carriers (they would break logical caret hit-mapping).
    expect(line0.runs).toBeUndefined();
    // Text stays logical source order for copy / AT.
    expect(line0.text).toBe(SHIN + LAMED);
    // Anchored at the visual origin: 2×8px content right-aligned in 80 → x≈64.
    expect(line0.x).toBeCloseTo(64, 0);
  });

  it('LTR text is projected at x=0 (natural flow, no origin shift)', () => {
    const t = new Text('ab', { maxWidth: 80 });
    const line0 = t.getContentProjection()!.lines![0];
    expect(line0.runs).toBeUndefined();
    expect(line0.x).toBe(0);
  });

  it('projects Arabic as LOGICAL source chars, not shaped presentation forms', () => {
    // Arabic "كتب" shapes to contextual forms (U+FExx) on canvas, but the
    // projection line text must expose the original base letters for copy / AT.
    const src = '\u0643\u062A\u0628'; // ك ت ب
    const t = new Text(src, { maxWidth: 200, font: '18px sans-serif' });
    const line0 = t.getContentProjection()!.lines![0];
    expect(line0.runs).toBeUndefined();
    for (const ch of line0.text) {
      const cp = ch.codePointAt(0)!;
      expect(cp).toBeGreaterThanOrEqual(0x0600);
      expect(cp).toBeLessThanOrEqual(0x06ff);
    }
    expect(line0.text).toBe(src);
  });

  // The projection keeps a single logical string (browser does its own bidi for
  // caret mapping); BidiResolver.logicalToVisualRuns is the engine-authoritative
  // source→visual mapping that lets a caller compute exact selection rectangles
  // for a logical sub-range without depending on the browser's reorder agreeing.
  describe('source↔visual mapping for sub-range selection rectangles', () => {
    const ALEF = '\u05D0';
    const BET = '\u05D1';
    const GIMEL = '\u05D2';

    it('maps a logical sub-range of an RTL line to its mirrored visual columns', () => {
      // "אבג" (RTL): visual order is reversed → col0=ג(2) col1=ב(1) col2=א(0).
      const src = ALEF + BET + GIMEL;
      // Select the first two LOGICAL chars (אב); visually they occupy the two
      // RIGHTMOST columns [1,3).
      expect(BidiResolver.logicalToVisualRuns(src, 0, 2)).toEqual([
        { visualStart: 1, visualEnd: 3 },
      ]);
    });

    it('splits into disjoint visual rects when the range leaves a visual gap', () => {
      // Arabic "مرحبا 42" — the Latin digits "42" flow LTR (visual columns 0,1)
      // inside the RTL line. Selecting the whole line EXCEPT the final digit
      // excludes logical char 7, which sits at visual column 1 — visually
      // between the two digits — so the selection becomes discontiguous and must
      // paint two rectangles.
      const src = '\u0645\u0631\u062D\u0628\u0627 42';
      const runs = BidiResolver.logicalToVisualRuns(src, 0, src.length - 1);
      expect(runs.length).toBeGreaterThan(1);
      // The runs cover exactly the visual columns holding those logical indices.
      const idx = BidiResolver.reorderIndices(src);
      const want = idx
        .map((l, v) => ({ l, v }))
        .filter(({ l }) => l >= 0 && l < src.length - 1)
        .map(({ v }) => v)
        .sort((a, b) => a - b);
      const got: number[] = [];
      for (const r of runs) for (let v = r.visualStart; v < r.visualEnd; v++) got.push(v);
      expect(got.sort((a, b) => a - b)).toEqual(want);
    });

    it('is a plain contiguous run for an LTR line (no mirroring)', () => {
      expect(BidiResolver.logicalToVisualRuns('hello', 1, 4)).toEqual([
        { visualStart: 1, visualEnd: 4 },
      ]);
    });
  });
});

describe('Text ScrollVirtualizable (ScrollView-driven line culling)', () => {
  // Twenty unique rows ('row0'..'row19'), lineHeight default 20 → line i spans
  // y ∈ [20i, 20(i+1)). No DOM here, so geometry is deterministic (8px chars).
  function tallBody(prefix: string): string {
    return Array.from({ length: 20 }, (_, i) => `${prefix}${i}`).join('\n');
  }

  /** Map a drawn baseline back to its visual row index (draw y = (row+0.8)·20). */
  const rowOfY = (y: number): number => Math.round((y - 0.8 * 20) / 20);

  it('renders every line when never driven (zero behavior change)', () => {
    const { r, lines } = recordingRenderer();
    new Text(tallBody('row')).render(r);
    expect(lines).toHaveLength(20);
  });

  it('culls fast-path lines outside [scrollY, scrollY+viewportHeight] plus two-line overscan', () => {
    // The viewport covers rows 5..9 exactly (y 100..300); ±2 overscan widens
    // the drawn window to rows 3..17.
    const t = new Text(tallBody('row'));
    t.setVisibleRange(100, 200);
    const { r, lines } = recordingRenderer();
    t.render(r);
    expect(lines).toEqual(Array.from({ length: 15 }, (_, k) => `row${k + 3}`));
  });

  it('clamps the window at the top edge', () => {
    const t = new Text(tallBody('row'));
    t.setVisibleRange(0, 60); // rows 0..2 visible + overscan → window clamped to 0..5
    const { r, lines } = recordingRenderer();
    t.render(r);
    expect(lines).toEqual(Array.from({ length: 6 }, (_, k) => `row${k}`));
  });

  it('clamps a scroll far past the bottom to the last line', () => {
    const t = new Text(tallBody('row'));
    t.setVisibleRange(999_999, 200);
    const { r, lines } = recordingRenderer();
    t.render(r);
    expect(lines).toEqual(['row19']);
  });

  it('culls glyphs by their computed line on the justify path too', () => {
    const t = new Text(tallBody('row'), { maxWidth: 200, textAlign: 'justify' });
    t.setVisibleRange(80, 40); // viewport rows 4..6 + overscan → window 2..8
    const { r, calls } = xyRecorder();
    t.render(r);
    const drawnRows = new Set(calls.map((c) => rowOfY(c.y)));
    expect(drawnRows).toEqual(new Set([2, 3, 4, 5, 6, 7, 8]));
  });

  it('resets the window on setText so every line draws until the next drive', () => {
    const t = new Text(tallBody('row'));
    t.setVisibleRange(100, 200);
    const culled = recordingRenderer();
    t.render(culled.r);
    expect(culled.lines).toHaveLength(15);

    t.setText(tallBody('alt'));
    const after = recordingRenderer();
    t.render(after.r);
    expect(after.lines).toHaveLength(20);
  });

  it('resets the window on setMaxWidth', () => {
    const t = new Text(tallBody('row'), { maxWidth: 400 });
    t.setVisibleRange(100, 200);
    const culled = recordingRenderer();
    t.render(culled.r);
    expect(culled.lines).toHaveLength(15);

    t.setMaxWidth(800);
    const after = recordingRenderer();
    t.render(after.r);
    expect(after.lines).toHaveLength(20);
  });

  it('keeps per-line alignment offsets for exactly the windowed lines', () => {
    // Twelve rows of DIFFERENT widths ('a'..'aaaaaaaaaaaa'), centered in
    // maxWidth 80: row i is (i+1)×8px wide → offset (80 − 8(i+1))/2 = 36 − 4i.
    // Culling decides WHICH lines draw; each drawn line must still carry its
    // own offset — windowing and alignment are orthogonal per-line concerns.
    const body = Array.from({ length: 12 }, (_, i) => 'a'.repeat(i + 1)).join('\n');
    const t = new Text(body, { maxWidth: 80, textAlign: 'center' });
    // Viewport covers rows 3..4; ±2 overscan widens the drawn window to 1..7.
    t.setVisibleRange(60, 40);
    const { r, calls } = xyRecorder();
    t.render(r);
    expect(calls.map((c) => c.text)).toEqual([
      'aa',
      'aaa',
      'aaaa',
      'aaaaa',
      'aaaaaa',
      'aaaaaaa',
      'aaaaaaaa',
    ]);
    expect(calls.map((c) => c.x)).toEqual([32, 28, 24, 20, 16, 12, 8]);
  });

  it('aligned text culls on the projection side too (hint band, offsets intact)', () => {
    const body = Array.from({ length: 12 }, (_, i) => 'a'.repeat(i + 1)).join('\n');
    const t = new Text(body, { maxWidth: 80, textAlign: 'right' });
    // Band y∈[60,100] at lineHeight 20 selects rows 2..5; right-aligned row i
    // sits at 80 − 8(i+1), so the compacted band still carries exact offsets.
    const p = t.getContentProjection({ minY: 60, maxY: 100 });
    const rows = p!.lines!.map((l) => l.text.length - 1);
    expect(rows).toEqual([2, 3, 4, 5]);
    expect(p!.lines!.map((l) => l.x)).toEqual([56, 48, 40, 32]);
  });
});
