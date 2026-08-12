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
/**
 * Right edge of the lowest-y line in `calls`.
 *
 * Derives the extent from each call's TEXT LENGTH rather than assuming one glyph
 * per call: `RichText` coalesces adjacent same-style glyphs into a single
 * `fillText`, so a call can carry a whole run. The stub measurer used by these
 * tests reports 8px per character, which is what makes `8 * length` exact here.
 */
function lineRightEdge(calls: DrawCall[]): number {
  const y0 = Math.min(...calls.map((c) => c.y));
  const line0 = calls.filter((c) => c.y === y0 && c.text.trim());
  return Math.max(...line0.map((c) => c.x + 8 * c.text.length));
}

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

  it('draws a run in its own fontFamily (inline monospace code) while others keep the base family', () => {
    const { r, calls } = recordingRenderer();
    new RichText([{ text: 'p' }, { text: 'c', style: { fontFamily: 'ui-monospace, monospace' } }], {
      font: '16px Georgia, serif',
    }).render(r);
    // The code run's drawn font carries the monospace stack…
    expect(calls.find((c) => c.text === 'c')?.font).toContain('monospace');
    // …while the plain prose run keeps the base family and is NOT monospace.
    const plain = calls.find((c) => c.text === 'p')?.font ?? '';
    expect(plain).toContain('Georgia');
    expect(plain).not.toContain('monospace');
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
      return lineRightEdge(calls);
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
    const canvasRight = lineRightEdge(calls);
    expect(right).toBeCloseTo(canvasRight, 0);
  });

  it('left-aligned single-style RichText emits per-grapheme carriers, not runs', () => {
    const rt = new RichText([{ text: 'aa aa aa aa aa' }], { maxWidth: 80 });
    const line0 = rt.getContentProjection()!.lines![0];
    // A single-style ragged line takes the per-grapheme carrier path instead of
    // styled runs: Scene pins each cluster to its canvas prefix, which is what
    // corrects the Gecko grid-fit drift. `runs` is omitted so Scene reaches that
    // branch at all — it is gated on the line having no runs.
    expect(line0.perGraphemeCarriers).toBe(true);
    expect(line0.runs).toBeUndefined();
  });

  it('left-aligned mixed-style RichText emits per-run widths and no x (GH-458)', () => {
    // Each run carries the width the canvas advanced for it, measured at its OWN
    // font, so Scene can pin the DOM carrier to it instead of letting the browser
    // measure the same text differently — the drift on bold/link spans.
    //
    // And NO `x`: a packed run's x is the sum of the preceding widths, so it
    // would carry no information, while setting it makes Scene force `dir="ltr"`
    // on the line box and the line must keep `auto` to stay bidi-correct.
    // In jsdom there is no real canvas, so widths are 0; the contract under test
    // is which FIELDS are present.
    const rt = new RichText([{ text: 'aa ', style: { bold: true } }, { text: 'bb cc' }], {
      maxWidth: 200,
    });
    const line0 = rt.getContentProjection()!.lines![0];
    expect(line0.perGraphemeCarriers).toBe(false);
    const runs = line0.runs!;
    expect(runs.length).toBeGreaterThan(1);
    for (const run of runs) {
      expect(typeof run.width).toBe('number');
      expect(run.x).toBeUndefined();
    }
    // Styles stay distinct — the whole reason these lines cannot use the
    // single-font per-grapheme path.
    expect(runs.some((run) => run.font?.includes('bold'))).toBe(true);
    expect(runs.some((run) => !run.font?.includes('bold'))).toBe(true);
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

  describe('visual-line-group memoization', () => {
    it('reuses the same projected lines across calls when layout is unchanged', () => {
      const rt = new RichText([{ text: 'hello world foo bar' }], {
        maxWidth: 120,
      });
      const a = rt.getContentProjection()!.lines!;
      const b = rt.getContentProjection()!.lines!;
      // The memo caches the built visual-line groups: projectedLines() re-maps a
      // fresh outer array, but each line's projection object is the SAME
      // reference across calls — proving the O(glyphs) group build did not rerun.
      expect(a.length).toBe(b.length);
      for (let i = 0; i < a.length; i++) expect(b[i]).toBe(a[i]);
      // A render pass (which also calls visualLineGroups) does not invalidate it.
      const { r } = recordingRenderer();
      rt.render(r);
      const c = rt.getContentProjection()!.lines!;
      for (let i = 0; i < a.length; i++) expect(c[i]).toBe(a[i]);
    });

    it('rebuilds after a layout-changing mutation', () => {
      const rt = new RichText([{ text: 'hello world' }], { maxWidth: 120 });
      const before = rt.getContentProjection()!.lines!;
      rt.setSpans([{ text: 'completely different text here' }]);
      const after = rt.getContentProjection()!.lines!;
      // New layout → fresh groups (different reference, and different content).
      expect(after).not.toBe(before);
      expect(after.map((l) => l.text).join('')).toContain('different');
    });

    it('rebuilds after setMaxWidth changes wrapping', () => {
      const rt = new RichText([{ text: 'aa bb cc dd ee ff gg hh' }], {
        maxWidth: 200,
      });
      const wide = rt.getContentProjection()!.lines!;
      rt.setMaxWidth(40);
      const narrow = rt.getContentProjection()!.lines!;
      expect(narrow).not.toBe(wide);
      // Narrower width wraps into more visual lines.
      expect(narrow.length).toBeGreaterThan(wide.length);
    });
  });
});

describe('RichText inline objects', () => {
  const OBJ = '\ufffc';

  it('does not paint the object replacement sentinel', () => {
    const { r, calls } = recordingRenderer();
    new RichText([
      { text: 'a' },
      { text: OBJ, object: { width: 40, height: 20, alt: 'x+1' } },
      { text: 'b' },
    ]).render(r);
    // The surrounding text still draws…
    expect(calls.some((c) => c.text.includes('a'))).toBe(true);
    expect(calls.some((c) => c.text.includes('b'))).toBe(true);
    // …but the sentinel must never reach fillText, or it paints a tofu box in
    // the gap that was reserved for someone else's content.
    expect(calls.some((c) => c.text.includes(OBJ))).toBe(false);
  });

  it('invokes the object painter at the box the engine reserved', () => {
    const { r, calls } = recordingRenderer();
    const boxes: Array<{
      x: number;
      y: number;
      width: number;
      height: number;
    }> = [];
    const rt = new RichText([
      { text: 'a ' },
      {
        text: OBJ,
        object: {
          width: 40,
          height: 20,
          alt: 'x+1',
          paint: (_surface, box) => boxes.push({ ...box }),
        },
      },
      { text: ' b' },
    ]);
    rt.render(r);

    // Exactly once per render — not per line, and not once per glyph in the run.
    expect(boxes).toHaveLength(1);
    // The box is the reservation, passed through unchanged.
    expect(boxes[0].width).toBe(40);
    expect(boxes[0].height).toBe(20);
    // And it sits where the text stopped: 'a ' is two 8px glyphs in the stub
    // measurer, so the box starts at 16 and the following ' b' starts after it.
    expect(boxes[0].x).toBeCloseTo(16, 5);
    const after = calls.find((c) => c.text.includes('b'));
    expect(after).toBeDefined();
    expect(after!.x).toBeGreaterThanOrEqual(boxes[0].x + boxes[0].width - 0.01);
  });

  it('passes the renderer through as the paint surface', () => {
    const { r } = recordingRenderer();
    let surface: unknown;
    new RichText([
      {
        text: OBJ,
        object: { width: 40, height: 20, paint: (s) => (surface = s) },
      },
    ]).render(r);
    // The painter draws through the same renderer the text does, rather than a
    // wrapper it would have to be taught about.
    expect(surface).toBe(r);
  });

  it('renders an object without a painter as a blank gap rather than throwing', () => {
    const { r, calls } = recordingRenderer();
    // The pre-fix inline-math behaviour. Kept as a test because it is the
    // degradation path for any consumer that reserves a box and paints it itself
    // by reading the layout result back.
    expect(() =>
      new RichText([{ text: 'a' }, { text: OBJ, object: { width: 40, height: 20 } }]).render(r),
    ).not.toThrow();
    expect(calls.some((c) => c.text.includes(OBJ))).toBe(false);
  });

  it('breaks the coalesced run at the object', () => {
    const { r, calls } = recordingRenderer();
    new RichText([
      { text: 'ab' },
      { text: OBJ, object: { width: 40, height: 20 } },
      { text: 'cd' },
    ]).render(r);
    // 'ab' and 'cd' are the same style but not contiguous — the reserved box sits
    // between them, so they must not be coalesced into one 'abcd' fillText.
    expect(calls.some((c) => c.text === 'abcd')).toBe(false);
    const texts = calls.map((c) => c.text);
    expect(texts).toContain('ab');
    expect(texts).toContain('cd');
  });

  it('uses the object alt for the accessible name, not the sentinel', () => {
    const rt = new RichText([
      { text: 'see ' },
      { text: OBJ, object: { width: 40, height: 20, alt: 'x+1' } },
    ]);
    expect(rt.getA11yAttributes().label).toBe('see x+1');
    expect(rt.getA11yAttributes().label).not.toContain(OBJ);
  });

  it('contributes nothing to the accessible name when alt is absent', () => {
    const rt = new RichText([{ text: 'ab' }, { text: OBJ, object: { width: 40, height: 20 } }]);
    expect(rt.getA11yAttributes().label).toBe('ab');
  });

  it('reserves horizontal space so following text is pushed right', () => {
    const { r, calls } = recordingRenderer();
    new RichText([
      { text: 'a' },
      { text: OBJ, object: { width: 40, height: 20 } },
      { text: 'b' },
    ]).render(r);
    // The stub measurer in this suite reports 8px per character, so 'a' advances
    // to 8 and the 40px reservation puts 'b' at 48.
    //
    // Deliberately an absolute assertion, not a diff against an object-free
    // render: without the object, 'a' and 'b' are contiguous same-style glyphs and
    // coalesce into ONE fillText('ab') at x=0, so there is no 'b' call to diff
    // against and the comparison silently measures the wrong thing.
    expect(calls.find((c) => c.text === 'b')!.x).toBeCloseTo(48, 5);
  });

  it('grows the line box for an object taller than the text', () => {
    const { r: rShort, calls: short } = recordingRenderer();
    new RichText([{ text: 'a' }]).render(rShort);
    const { r: rTall, calls: tall } = recordingRenderer();
    new RichText([{ text: 'a' }, { text: OBJ, object: { width: 10, height: 40 } }]).render(rTall);
    // A taller line pushes the shared baseline down, so the text's draw y moves.
    expect(tall.find((c) => c.text === 'a')!.y).toBeGreaterThan(
      short.find((c) => c.text.includes('a'))!.y,
    );
  });
});

describe('strikethrough (GFM del)', () => {
  /** Records fillText plus the moveTo/lineTo/stroke triples a strike emits. */
  function strikeRecordingRenderer(): {
    r: IRenderer;
    text: DrawCall[];
    lines: Array<{ x1: number; y1: number; x2: number; y2: number; width: number }>;
  } {
    const text: DrawCall[] = [];
    const lines: Array<{ x1: number; y1: number; x2: number; y2: number; width: number }> = [];
    let from: { x: number; y: number } | null = null;
    let to: { x: number; y: number } | null = null;
    const r = new Proxy(
      {},
      {
        get(_t, prop) {
          switch (prop) {
            case 'fillText':
              return (t: string, x: number, y: number, font: string, color: string) =>
                text.push({ text: t, x, y, font, color });
            case 'moveTo':
              return (x: number, y: number) => {
                from = { x, y };
              };
            case 'lineTo':
              return (x: number, y: number) => {
                to = { x, y };
              };
            case 'stroke':
              return (_color: string, width: number) => {
                if (from && to) lines.push({ x1: from.x, y1: from.y, x2: to.x, y2: to.y, width });
                from = null;
                to = null;
              };
            default:
              return () => {};
          }
        },
      },
    ) as unknown as IRenderer;
    return { r, text, lines };
  }

  it('strokes one line across a struck run, not one per glyph', () => {
    // The link underline needs a segment per glyph; a strike does not, and the run
    // is already coalesced, so one segment must span it.
    const rt = new RichText([{ text: 'gone', style: { lineThrough: true } }]);
    const { r, lines } = strikeRecordingRenderer();
    rt.render(r);
    expect(lines).toHaveLength(1);
    expect(lines[0].x2).toBeGreaterThan(lines[0].x1);
    expect(lines[0].y1).toBe(lines[0].y2);
  });

  it('draws no line when nothing is struck', () => {
    const rt = new RichText([{ text: 'plain' }]);
    const { r, lines } = strikeRecordingRenderer();
    rt.render(r);
    expect(lines).toHaveLength(0);
  });

  it('does not coalesce a struck run with an unstruck neighbour', () => {
    // Struck-ness is part of the coalescing key. Without that, one line would be
    // stroked across the whole run and strike the unstruck half too.
    const rt = new RichText([{ text: 'keep' }, { text: 'gone', style: { lineThrough: true } }]);
    const { r, text, lines } = strikeRecordingRenderer();
    rt.render(r);
    expect(lines).toHaveLength(1);
    const struckCall = text.find((c) => c.text === 'gone');
    expect(struckCall).toBeDefined();
    // The line must start at the struck run, not at the start of the text.
    expect(lines[0].x1).toBeCloseTo(struckCall!.x, 0);
    const keepCall = text.find((c) => c.text === 'keep');
    expect(lines[0].x1).toBeGreaterThanOrEqual(keepCall!.x + 8 * 'keep'.length - 1);
  });

  it('strikes a struck link, which takes the per-glyph path', () => {
    // `~~[gone](url)~~` lexes to a `del` wrapping a `link`, so this is reachable.
    // The link branch returns before flushRun, so it needs its own strike call.
    const rt = new RichText([{ text: 'ab', style: { lineThrough: true, href: 'http://x.com' } }]);
    const { r, lines } = strikeRecordingRenderer();
    rt.render(r);
    // Two glyphs: each emits an underline AND a strike, so 4 segments.
    expect(lines).toHaveLength(4);
    const ys = [...new Set(lines.map((l) => l.y1))].sort((a, b) => a - b);
    expect(ys).toHaveLength(2); // strike above baseline, underline below
    expect(ys[0]).toBeLessThan(ys[1]);
  });

  it('scales the line weight with the run size so a heading is not hairlined', () => {
    const small = new RichText([{ text: 'x', style: { lineThrough: true, fontSize: 14 } }]);
    const large = new RichText([{ text: 'x', style: { lineThrough: true, fontSize: 32 } }]);
    const a = strikeRecordingRenderer();
    const b = strikeRecordingRenderer();
    small.render(a.r);
    large.render(b.r);
    expect(b.lines[0].width).toBeGreaterThan(a.lines[0].width);
  });

  it('draws a baseline-shifted run on its own baseline', () => {
    // Positive shift = up: the run's fillText y must sit exactly `shift` above
    // its unshifted neighbour's, and the two glyphs stay on the same visual line.
    const { r, calls } = recordingRenderer();
    new RichText([{ text: 'a' }, { text: 'b', style: { baselineShift: 5 } }]).render(r);
    const a = calls.find((c) => c.text === 'a')!;
    const b = calls.find((c) => c.text === 'b')!;
    expect(b.y).toBeCloseTo(a.y - 5, 5);
  });

  it('does not coalesce a shifted run into an unshifted one', () => {
    // The run baseline is part of the coalescing key: without it, the shifted
    // glyphs would be merged into the preceding run and drawn back on the
    // shared baseline, silently dropping the shift.
    const { r, calls } = recordingRenderer();
    new RichText([{ text: 'ab' }, { text: 'cd', style: { baselineShift: 5 } }]).render(r);
    expect(calls.map((c) => c.text)).toEqual(['ab', 'cd']);
    const shifted = calls.find((c) => c.text === 'cd')!;
    const plain = calls.find((c) => c.text === 'ab')!;
    expect(shifted.y).toBeCloseTo(plain.y - 5, 5);
  });

  it('coalesces adjacent shifted glyphs that share one shift', () => {
    const { r, calls } = recordingRenderer();
    new RichText([{ text: 'ab', style: { baselineShift: 5 } }]).render(r);
    expect(calls.map((c) => c.text)).toEqual(['ab']);
  });

  it('strikes a shifted run on its own baseline', () => {
    // The strike line hangs off the run's own baseline, or it would cut through
    // the WRONG vertical position of a raised run. A 12px run raised 3px fits
    // the line's slack (0.8*(16-12) = 3.2px), so the line does not grow and the
    // raised run's baseline genuinely sits 3px above the shared one.
    const shifted = strikeRecordingRenderer();
    new RichText([
      { text: 'o', style: { fontSize: 12, baselineShift: 3 } },
      { text: 'x', style: { lineThrough: true, fontSize: 12, baselineShift: 3 } },
    ]).render(shifted.r);
    const plain = strikeRecordingRenderer();
    new RichText([{ text: 'x', style: { lineThrough: true, fontSize: 12 } }]).render(plain.r);
    expect(shifted.lines).toHaveLength(1);
    expect(plain.lines).toHaveLength(1);
    expect(shifted.lines[0].y1).toBeCloseTo(plain.lines[0].y1 - 3, 5);
  });

  it("keeps a shifted run inside its line's projection", () => {
    // A shifted run must not split its visual line: it renders within the shared
    // line box, so the projection must still describe ONE line holding all text.
    const rt = new RichText([{ text: 'a' }, { text: 'b', style: { baselineShift: 5 } }]);
    const lines = rt.getContentProjection()!.lines!;
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('ab');
    // And the projected line baseline tracks the UNSHIFTED baseline, so the DOM
    // selection box lands where the surrounding text is.
    const baseline = lines[0].baseline;
    const { r, calls } = recordingRenderer();
    rt.render(r);
    const a = calls.find((c) => c.text === 'a')!;
    expect(a.y).toBeCloseTo(lines[0].y + baseline, 5);
  });
});
