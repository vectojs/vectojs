import { describe, it, expect } from 'vitest';
import { LayoutEngine, type GlyphMeasurer, type StyledSpan } from '../src/LayoutEngine';

const measurer: GlyphMeasurer = { measure: (_char, fontSize) => fontSize * 0.5 };
const EMPTY_ATLAS = {};
const engine = () => new LayoutEngine(1000, 1000, measurer);

/**
 * Streaming / typewriter mode (Campaign 1, PR C): re-`prepareRich` of a growing styled
 * document reuses its untouched paragraphs by reference (the rich paragraph
 * memo), so per-token cost is O(changed paragraph), not O(document).
 */
describe('prepareRich — paragraph memoization (rich streaming)', () => {
  it('reuses untouched leading paragraphs by reference after an append', () => {
    const e = engine();
    const head: StyledSpan[] = [{ text: 'one\n' }, { text: 'two', style: { color: '#f00' } }];
    const a = e.prepareRich(head, EMPTY_ATLAS, 20);
    const b = e.prepareRich([...head, { text: '\nthree' }], EMPTY_ATLAS, 20);

    expect(b.paragraphs[0]).toBe(a.paragraphs[0]); // 'one' — reused
    expect(b.paragraphs[1]).toBe(a.paragraphs[1]); // 'two' (#f00) — reused
    expect(b.paragraphs[2].words.flatMap((w) => w.glyphs.map((g) => g.char)).join('')).toBe(
      'three',
    );
  });

  it('reuses a paragraph even when the caller passes fresh style objects (value-keyed)', () => {
    const e = engine();
    const a = e.prepareRich([{ text: 'hi', style: { bold: true } }], EMPTY_ATLAS, 20);
    // A brand-new { bold: true } object with identical values must still hit.
    const b = e.prepareRich(
      [{ text: 'hi', style: { bold: true } }, { text: '\nbye' }],
      EMPTY_ATLAS,
      20,
    );
    expect(b.paragraphs[0]).toBe(a.paragraphs[0]);
  });

  it('rebuilds a paragraph when its inline style changes', () => {
    const e = engine();
    const a = e.prepareRich([{ text: 'hi', style: { color: '#f00' } }], EMPTY_ATLAS, 20);
    const b = e.prepareRich([{ text: 'hi', style: { color: '#00f' } }], EMPTY_ATLAS, 20);
    expect(b.paragraphs[0]).not.toBe(a.paragraphs[0]);
    expect(b.paragraphs[0].words[0].glyphs[0].style?.color).toBe('#00f');
  });

  it('keeps per-glyph styles correct across the reuse boundary', () => {
    const e = engine();
    e.prepareRich([{ text: 'red', style: { color: '#f00' } }], EMPTY_ATLAS, 20);
    const b = e.prepareRich(
      [
        { text: 'red', style: { color: '#f00' } },
        { text: '\nblue', style: { color: '#00f' } },
      ],
      EMPTY_ATLAS,
      20,
    );
    expect(b.paragraphs[0].words[0].glyphs[0].style?.color).toBe('#f00'); // reused
    expect(b.paragraphs[1].words[0].glyphs[0].style?.color).toBe('#00f'); // fresh
  });
});
