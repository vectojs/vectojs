import { describe, expect, it } from 'vitest';
import {
  LayoutEngine,
  LayoutResultBuffer,
  type GlyphAtlas,
  type StyledSpan,
} from '../src/LayoutEngine';

/**
 * Baseline shift (`TextStyle.baselineShift`, positive = UP): a run drawn on its
 * own baseline instead of the shared one, with the line box growing when the
 * shifted glyph box would leave it — the same contract inline objects have.
 *
 * Pinned here: the sign convention, the y placement, line growth (and the
 * no-growth case that keeps ordinary superscripts from loosening leading), the
 * memo key, the streaming prefix compare, and `measurePrepared`/buffer-path
 * agreement with the allocating path.
 */

const ATLAS: GlyphAtlas = {
  a: { width: 10, baseSize: 16, ast: null },
  b: { width: 10, baseSize: 16, ast: null },
  c: { width: 10, baseSize: 16, ast: null },
  ' ': { width: 5, baseSize: 16, ast: null },
};

function engine(maxWidth = 1000): LayoutEngine {
  const e = new LayoutEngine();
  e.maxWidth = maxWidth;
  e.maxHeight = 10_000;
  return e;
}

describe('baseline shift placement', () => {
  it('raises a run (positive shift) above the shared baseline', () => {
    const e = engine();
    const res = e.layoutPrepared(
      e.prepareRich(
        [{ text: 'a' }, { text: 'b', style: { baselineShift: 4 } }, { text: 'c' }],
        ATLAS,
        16,
      ),
    );
    const a = res.nodes.find((n) => n.char === 'a')!;
    const b = res.nodes.find((n) => n.char === 'b')!;
    const c = res.nodes.find((n) => n.char === 'c')!;
    // Same size, so the only y difference is the shift: b sits 4px above a/c.
    expect(a.y).toBe(c.y);
    expect(b.y).toBeCloseTo(a.y - 4, 5);
    // Both still have their own baseline 0.8em above their top.
    expect(b.y + 16 * 0.8).toBeCloseTo(a.y + 16 * 0.8 - 4, 5);
  });

  it('lowers a run (negative shift) below the shared baseline', () => {
    const e = engine();
    const res = e.layoutPrepared(
      e.prepareRich([{ text: 'a' }, { text: 'b', style: { baselineShift: -4 } }], ATLAS, 16),
    );
    const a = res.nodes.find((n) => n.char === 'a')!;
    const b = res.nodes.find((n) => n.char === 'b')!;
    expect(b.y).toBeCloseTo(a.y + 4, 5);
  });
});

describe('baseline shift vs the line box', () => {
  it('does not grow the line when the shifted run fits the existing slack', () => {
    const e = engine();
    // A 12px run in a 16px paragraph has 0.8*(16-12) = 3.2px of slack above it;
    // a 3px raise fits inside it, so the line must stay untouched.
    const shifted = e.layoutPrepared(
      e.prepareRich(
        [{ text: 'a' }, { text: 'b', style: { fontSize: 12, baselineShift: 3 } }],
        ATLAS,
        16,
      ),
    );
    const plain = e.layoutPrepared(
      e.prepareRich([{ text: 'a' }, { text: 'b', style: { fontSize: 12 } }], ATLAS, 16),
    );
    expect(shifted.totalHeight).toBe(plain.totalHeight);
    // The raised glyph's top stays at or below the line top.
    const b = shifted.nodes.find((n) => n.char === 'b')!;
    expect(b.y).toBeGreaterThanOrEqual(0);
  });

  it('grows the line so a raised run is not clipped above the line top', () => {
    const e = engine();
    const plain = e.layoutPrepared(e.prepareRich([{ text: 'a' }], ATLAS, 16));
    // A same-size 4px raise has no slack (0.8*(16-16) = 0), so the line must grow.
    const raised = e.layoutPrepared(
      e.prepareRich([{ text: 'a' }, { text: 'b', style: { baselineShift: 4 } }], ATLAS, 16),
    );
    expect(raised.totalHeight).toBeGreaterThan(plain.totalHeight);
    const b = raised.nodes.find((n) => n.char === 'b')!;
    expect(b.y).toBeGreaterThanOrEqual(0);
  });

  it('grows the line so a lowered run is not clipped below the line bottom', () => {
    const e = engine();
    const plain = e.layoutPrepared(e.prepareRich([{ text: 'a' }], ATLAS, 16));
    // Descent slack is 0.7*16 = 11.2px; a 14px drop overflows it.
    const lowered = e.layoutPrepared(
      e.prepareRich([{ text: 'a' }, { text: 'b', style: { baselineShift: -14 } }], ATLAS, 16),
    );
    expect(lowered.totalHeight).toBeGreaterThan(plain.totalHeight);
    const b = lowered.nodes.find((n) => n.char === 'b')!;
    // Glyph bottom = baseline + 0.2*16 must stay inside the line box.
    expect(b.y + 16 * 0.8 - 14 + 16 * 0.2).toBeLessThanOrEqual(lowered.totalHeight);
  });

  it('stacks shifts: the tallest shifted run drives the line, one baseline shared', () => {
    const e = engine();
    const res = e.layoutPrepared(
      e.prepareRich(
        [
          { text: 'a' },
          { text: 'b', style: { baselineShift: 3 } },
          { text: 'c', style: { baselineShift: 9 } },
        ],
        ATLAS,
        16,
      ),
    );
    const a = res.nodes.find((n) => n.char === 'a')!;
    const b = res.nodes.find((n) => n.char === 'b')!;
    const c = res.nodes.find((n) => n.char === 'c')!;
    // Each run keeps its own baseline; the unshifted run keeps the shared one.
    expect(a.y + 16 * 0.8).toBeCloseTo((0.8 * res.totalHeight) / 1.5, 5);
    expect(b.y + 16 * 0.8).toBeCloseTo(a.y + 16 * 0.8 - 3, 5);
    expect(c.y + 16 * 0.8).toBeCloseTo(a.y + 16 * 0.8 - 9, 5);
  });
});

describe('baseline shift memo and streaming', () => {
  it('does not serve one paragraph the layout of a differently-shifted one', () => {
    // The richParagraphCache key carries baselineShift (like fontSize), or the
    // second shape would reuse the first's prepared glyphs — including their
    // style objects — and draw at the wrong y. A 12px run shifted 2px fits the
    // slack and leaves the line at 16; shifted 8px grows it, so the unshifted
    // follower's y is the discriminator (0 vs 4.8).
    const e = engine();
    const yOfC = (shift: number): number =>
      e
        .layoutPrepared(
          e.prepareRich(
            [{ text: 'ab', style: { fontSize: 12, baselineShift: shift } }, { text: ' c' }],
            ATLAS,
            16,
          ),
        )
        .nodes.find((n) => n.char === 'c')!.y;
    expect(yOfC(2)).toBeCloseTo(0, 5);
    expect(yOfC(8)).toBeCloseTo((22 - 16) * 0.8, 5);
    expect(yOfC(8)).toBeGreaterThan(yOfC(2) + 4);
  });

  it('reshapes a retained streaming prefix whose shift changed', () => {
    const e = engine();
    const yOfB = (spans: StyledSpan[]): number =>
      e.layoutPrepared(e.prepareRich(spans, ATLAS, 16)).nodes.find((n) => n.char === 'b')!.y;
    // 2px shift fits the slack (line stays at 16, 'b' at y=0); 7px grows the
    // line (pMax 20.75, 'b' at y=3.8). styleRangeEquals must reject the cached
    // prefix, or 'b' keeps its old 0.
    const grown = [{ text: 'a', style: { fontSize: 12, baselineShift: 7 } }, { text: ' bc' }];
    expect(yOfB(grown)).toBeCloseTo((20.75 - 16) * 0.8, 5);
    expect(yOfB(grown)).toBeGreaterThan(3.5);
  });
});

describe('baseline shift across the fast paths', () => {
  it('measurePrepared agrees with layoutPrepared on height', () => {
    const e = engine();
    const spans: StyledSpan[] = [
      { text: 'a' },
      { text: 'b', style: { fontSize: 12, baselineShift: 4 } },
      { text: ' c' },
    ];
    const prepared = e.prepareRich(spans, ATLAS, 16);
    const measured = e.measurePrepared(prepared);
    const laidOut = e.layoutPrepared(prepared);
    expect(measured.height).toBeCloseTo(laidOut.totalHeight, 5);
  });

  it('buffer path agrees with the allocating path, shifted runs included', () => {
    const e = engine();
    const spans: StyledSpan[] = [
      { text: 'a' },
      { text: 'b', style: { fontSize: 12, baselineShift: 4 } },
      { text: ' c', style: { baselineShift: -2 } },
    ];
    const prepared = e.prepareRich(spans, ATLAS, 16);
    const nodes = e.layoutPrepared(prepared).nodes;
    const buffer = new LayoutResultBuffer();
    e.layoutPreparedIntoBuffer(prepared, buffer);

    expect(buffer.count).toBe(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      expect(buffer.chars[i]).toBe(nodes[i].char);
      expect(buffer.ys[i]).toBeCloseTo(nodes[i].y, 4);
    }
  });
});
