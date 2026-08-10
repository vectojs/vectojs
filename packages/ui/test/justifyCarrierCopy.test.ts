import { describe, expect, it } from 'vitest';
import { Text } from '../src/Text';

describe('Text justify carrier copy fidelity', () => {
  it('emits inter-word spaces as run text, so runs concatenate back to the line source', () => {
    const t = new Text('aa aa aa aa aa', { maxWidth: 80, textAlign: 'justify' });
    const proj = t.getContentProjection()!;
    for (const line of proj.lines!) {
      // The carriers ARE the line's text. Folding a space into a neighbouring
      // run's width instead emitted no space character at all, so a justified
      // paragraph copied as "aaaaaaaaaa".
      expect(line.runs!.map((r) => r.text).join('')).toBe(line.text);
    }
    // And the whole projection still reassembles the source.
    const copied = proj
      .lines!.map((l) => l.runs!.map((r) => r.text).join('') + (l.separatorAfter ?? ''))
      .join('');
    expect(copied).toBe('aa aa aa aa aa');
  });

  it('gives each inter-word space its own run spanning the widened justify gap', () => {
    const t = new Text('aa aa aa aa aa', { maxWidth: 80, textAlign: 'justify' });
    const proj = t.getContentProjection()!;
    const line0 = proj.lines![0].runs!;
    // Contiguous: each run reaches exactly the next run's x, so the highlight
    // covers the widened gap with no seam.
    for (let i = 0; i < line0.length - 1; i++) {
      expect(line0[i].x! + line0[i].width!).toBeCloseTo(line0[i + 1].x!, 5);
    }
    // Justify widened the gaps on the stretched line: its inter-word space runs
    // are wider than the natural advance the ragged final line keeps.
    const innerSpace = (runs: typeof line0) =>
      runs.filter((r, i) => r.text.trim() === '' && i < runs.length - 1);
    const stretched = innerSpace(line0);
    const ragged = innerSpace(proj.lines!.at(-1)!.runs!);
    expect(stretched.length).toBeGreaterThan(0);
    expect(ragged.length).toBeGreaterThan(0);
    expect(stretched[0].width!).toBeGreaterThan(ragged[0].width!);
  });

  it('places a collapsed line-trailing space at the line end with zero width', () => {
    // The engine leaves a justify-collapsed trailing space at the LAST WORD's own
    // x, which is why these runs must not be sorted by x: doing so splices the
    // space into that word and copy yields "…a a" instead of "…aa ".
    const t = new Text('aa aa aa aa aa', { maxWidth: 80, textAlign: 'justify' });
    const runs = t.getContentProjection()!.lines![0].runs!;
    const last = runs.at(-1)!;
    expect(last.text).toBe(' ');
    expect(last.width).toBe(0);
    // At the line end, i.e. flush to maxWidth — not back at the last word's x.
    expect(last.x).toBeCloseTo(80, 0);
    // The word before it still reaches maxWidth (justified flush).
    const lastWord = runs[runs.length - 2];
    expect(lastWord.x! + lastWord.width!).toBeCloseTo(80, 0);
  });

  it('keeps word runs at their own advance, not spanning into the gap', () => {
    const t = new Text('aa aa aa aa aa', { maxWidth: 80, textAlign: 'justify' });
    const runs = t.getContentProjection()!.lines![0].runs!;
    const words = runs.filter((r) => r.text.trim() !== '');
    expect(words.length).toBeGreaterThan(1);
    // Two glyphs of 8px each: the word's width is its own advance, with no gap
    // folded in.
    for (const w of words) expect(w.width).toBeCloseTo(16, 5);
  });

  it('runs stay in non-decreasing x order across a multi-line justified block', () => {
    const t = new Text('one two three four five six', {
      maxWidth: 120,
      textAlign: 'justify',
    });
    for (const line of t.getContentProjection()!.lines!) {
      const xs = line.runs!.map((r) => r.x!);
      expect(xs).toEqual([...xs].sort((a, b) => a - b));
      expect(line.runs!.map((r) => r.text).join('')).toBe(line.text);
    }
  });

  it('every positioned run carries a width, which the flow-relative carrier path requires', () => {
    // Scene advances its running inline offset by run.width; a positioned run
    // without one would desync every later carrier on the line and fall back to
    // the absolute (copy-breaking) path.
    const t = new Text('one two three four five six', {
      maxWidth: 120,
      textAlign: 'justify',
    });
    for (const line of t.getContentProjection()!.lines!) {
      for (const r of line.runs!) {
        expect(typeof r.x).toBe('number');
        expect(typeof r.width).toBe('number');
        expect(r.width).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
