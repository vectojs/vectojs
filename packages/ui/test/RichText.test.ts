import { describe, it, expect, vi } from 'vitest';
import type { IRenderer } from '@vectojs/core';
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
    new RichText([{ text: 'H', style: { fontSize: 40 } }], {
      font: '16px sans-serif',
    }).render(r);
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

  it('appendSpans streams new runs onto the layout and accessible name', () => {
    const { r, calls } = recordingRenderer();
    const rt = new RichText([{ text: 'a' }]);
    rt.appendSpans([{ text: 'b', style: { color: '#00ff00' } }]);
    rt.render(r);
    expect(calls.map((c) => c.text).join('')).toBe('ab');
    expect(calls.find((c) => c.text === 'b')?.color).toBe('#00ff00');
    expect(rt.getA11yAttributes().label).toBe('ab');
  });

  it('wakes an on-demand scene after streaming styled spans', () => {
    const rt = new RichText([{ text: 'first' }]);
    const markDirty = vi.fn();
    (rt as unknown as { _scene: { markDirty: () => void } })._scene = {
      markDirty,
    };
    rt.appendSpans([{ text: ' second', style: { bold: true } }]);
    expect(markDirty).toHaveBeenCalledOnce();
  });

  it('paints link runs in the link color by default', () => {
    const { r, calls } = recordingRenderer();
    new RichText([{ text: 'L', style: { href: 'https://x.dev' } }], {
      linkColor: '#1199ff',
    }).render(r);
    expect(calls.find((c) => c.text === 'L')?.color).toBe('#1199ff');
  });

  it('does not activate an obfuscated script link', () => {
    const onLinkClick = vi.fn();
    const rt = new RichText([{ text: 'unsafe', style: { href: 'java\nscript:alert(1)' } }], {
      onLinkClick,
    });
    const hotspot = rt.children[0];

    expect(hotspot.getA11yAttributes().href).toBe('#');
    hotspot.emit('click', {});
    expect(onLinkClick).not.toHaveBeenCalled();
  });

  it('flows around an exclusion rect (exclusion shapes): first line indents, later lines reclaim width', () => {
    const { r, calls } = recordingRenderer();
    // No DOM measurer → 0.5em fallback: at 16px each glyph is 8px wide, line 24px.
    const rt = new RichText([{ text: 'aaaa bbbb cccc dddd eeee ffff' }], {
      maxWidth: 160,
      exclusions: [{ x: 0, y: 0, width: 64, height: 24 }], // left float over line 1 only
    });
    rt.render(r);
    const firstLine = calls.filter((c) => c.y < 24);
    const below = calls.filter((c) => c.y >= 24);
    expect(Math.min(...firstLine.map((c) => c.x))).toBe(64); // pushed past the float
    expect(below.length).toBeGreaterThan(0);
    expect(Math.min(...below.map((c) => c.x))).toBe(0); // full width below it
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

  it('exposes concatenated span text for DOM content projection', () => {
    const rt = new RichText(
      [{ text: 'The ' }, { text: 'quick', style: { bold: true } }, { text: ' fox' }],
      { maxWidth: 240 },
    );
    const proj = rt.getContentProjection()!;
    expect(proj.text).toBe('The quick fox'); // rendered text, no markup noise
    expect(proj.font).toBe(rt.font);
  });

  // No DOM in this env, so the engine uses its portable 0.5em fallback: every
  // glyph is fontSize*0.5 = 8px wide at the default 16px font. That makes the
  // justify geometry deterministic without a real measurer.
  it('justify stretches a wrapped line flush to maxWidth', () => {
    const spans = [{ text: 'aa aa aa aa aa' }];
    const width = 80;
    const left = new RichText(spans, { maxWidth: width, textAlign: 'left' });
    const just = new RichText(spans, { maxWidth: width, textAlign: 'justify' });

    // Right edge (max x + glyph width) of the first visual line.
    const firstLineRight = (rt: RichText): number => {
      const { r, calls } = recordingRenderer();
      rt.render(r);
      const y0 = Math.min(...calls.map((c) => c.y));
      const line0 = calls.filter((c) => c.y === y0 && c.text.trim());
      return Math.max(...line0.map((c) => c.x + 8));
    };

    const leftRight = firstLineRight(left);
    const justRight = firstLineRight(just);
    expect(leftRight).toBeLessThan(width); // ragged: ends short of the edge
    expect(justRight).toBeCloseTo(width, 0); // justified: flush to maxWidth
    expect(justRight).toBeGreaterThan(leftRight);
  });

  it('justify leaves the paragraph-final line ragged', () => {
    const { r, calls } = recordingRenderer();
    new RichText([{ text: 'aa aa aa aa aa' }], {
      maxWidth: 80,
      textAlign: 'justify',
    }).render(r);
    const yMax = Math.max(...calls.map((c) => c.y));
    const lastLine = calls.filter((c) => c.y === yMax && c.text.trim());
    const lastRight = Math.max(...lastLine.map((c) => c.x + 8));
    expect(lastRight).toBeLessThan(80); // final line is not stretched
  });

  it('hyphenate breaks an overflowing word with a visible hyphen', () => {
    const { r, calls } = recordingRenderer();
    // Split the long word after 3 chars; at 8px/glyph and maxWidth 48 the tail
    // overflows and the break fires, drawing a '-'.
    new RichText([{ text: 'hyphenation' }], {
      maxWidth: 48,
      hyphenate: (w) => (w.length > 3 ? [w.slice(0, 3), w.slice(3)] : [w]),
    }).render(r);
    expect(calls.some((c) => c.text === '-')).toBe(true);
  });

  it('justify projection emits positioned runs overlapping the drawn glyphs', () => {
    const spans = [{ text: 'aa aa aa aa aa' }];
    const width = 80;
    const rt = new RichText(spans, { maxWidth: width, textAlign: 'justify' });
    const line0 = rt.getContentProjection()!.lines![0];
    // Positioned carriers (x + width) so the DOM selection box tracks the
    // widened canvas spacing, unlike the natural-flow ragged path.
    expect(
      line0.runs!.every((run) => typeof run.x === 'number' && typeof run.width === 'number'),
    ).toBe(true);
    // The run right edges reach flush to maxWidth (justified line 0).
    const right = Math.max(...line0.runs!.map((run) => run.x! + run.width!));
    expect(right).toBeCloseTo(width, 0);

    // The projected run x/width match the canvas glyph extent (selection overlap).
    const { r, calls } = recordingRenderer();
    rt.render(r);
    const y0 = Math.min(...calls.map((c) => c.y));
    const canvasRight = Math.max(
      ...calls.filter((c) => c.y === y0 && c.text.trim()).map((c) => c.x + 8),
    );
    expect(right).toBeCloseTo(canvasRight, 0);
  });

  it('left-aligned RichText keeps natural-flow runs (no positioned x)', () => {
    const rt = new RichText([{ text: 'aa aa aa aa aa' }], { maxWidth: 80 });
    const line0 = rt.getContentProjection()!.lines![0];
    expect(line0.runs!.every((run) => run.x === undefined)).toBe(true);
  });

  it('justify preserves per-style-run fonts and logical text in the projection', () => {
    const rt = new RichText(
      [
        { text: 'aa ', style: { bold: true } },
        { text: 'bb cc dd', style: { italic: true } },
      ],
      { maxWidth: 80, textAlign: 'justify' },
    );
    const runs = rt.getContentProjection()!.lines!.flatMap((line) => line.runs ?? []);
    // Bold and italic runs stay distinct (own font shorthand).
    expect(runs.some((run) => run.font?.includes('bold'))).toBe(true);
    expect(runs.some((run) => run.font?.includes('italic'))).toBe(true);
    // Concatenated run text round-trips to the logical source (no glyph forms).
    expect(runs.map((run) => run.text).join('')).toContain('aa');
  });
});
