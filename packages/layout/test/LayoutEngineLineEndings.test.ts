import { describe, it, expect } from 'vitest';
import { LayoutEngine, GlyphAtlas, LayoutResultBuffer } from '../src/LayoutEngine';

/**
 * Line endings must never be laid out as glyphs. Splitting the source on `'\n'`
 * used to leave a CRLF's `\r` at the end of the paragraph, where it was shaped
 * into a real node — a visible tofu box in most fonts, which also inflated the
 * line width and shifted selection. `sourceIndex` still has to index the
 * ORIGINAL text, so a CRLF break must account for both characters.
 */
describe('LayoutEngine line endings (CRLF / LF / lone CR)', () => {
  const atlas: GlyphAtlas = {
    A: { width: 20, baseSize: 32, ast: null },
    B: { width: 20, baseSize: 32, ast: null },
  };
  const engine = () => new LayoutEngine(1000, 1000);
  const shape = (text: string) =>
    engine()
      .layoutText(text, atlas, 32)
      .nodes.map((n) => ({ char: n.char, x: n.x, y: n.y }));

  it('never emits a \\r node for CRLF', () => {
    const nodes = engine().layoutText('A\r\nB', atlas, 32).nodes;
    expect(nodes.some((n) => n.char === '\r')).toBe(false);
    expect(nodes.map((n) => n.char)).toEqual(['A', 'B']);
  });

  it('lays CRLF out identically to LF', () => {
    expect(shape('A\r\nB')).toEqual(shape('A\nB'));
  });

  it('treats a lone CR as a line break, not a glyph', () => {
    expect(shape('A\rB')).toEqual(shape('A\nB'));
  });

  it('does not inflate the line width with a \\r', () => {
    const lf = engine().layoutText('A\nB', atlas, 32);
    const crlf = engine().layoutText('A\r\nB', atlas, 32);
    expect(crlf.totalWidth).toBe(lf.totalWidth);
  });

  it('keeps sourceIndex mapped to the original text across each break form', () => {
    const si = (text: string) =>
      engine()
        .layoutText(text, atlas, 32)
        .nodes.map((n) => n.sourceIndex);
    // 'B' sits at index 2 after "A\n", but index 3 after "A\r\n".
    expect(si('A\nB')).toEqual([0, 2]);
    expect(si('A\r\nB')).toEqual([0, 3]);
    expect(si('A\rB')).toEqual([0, 2]);
  });

  it('handles a CRLF-separated blank line (empty paragraph)', () => {
    const nodes = engine().layoutText('A\r\n\r\nB', atlas, 32).nodes;
    expect(nodes.some((n) => n.char === '\r')).toBe(false);
    expect(nodes.map((n) => n.char)).toEqual(['A', 'B']);
    // 'B' is at index 5 in "A\r\n\r\nB".
    expect(nodes[1].sourceIndex).toBe(5);
  });

  it('strips \\r on the rich path too', () => {
    const e = engine();
    const prepared = e.prepareRich([{ text: 'A\r\nB' }], atlas, 32);
    const nodes = e.layoutPrepared(prepared).nodes;
    expect(nodes.some((n) => n.char === '\r')).toBe(false);
    expect(nodes.map((n) => n.char)).toEqual(['A', 'B']);
  });

  it('strips \\r on the zero-GC buffer path too', () => {
    const e = engine();
    const buffer = new LayoutResultBuffer();
    e.layoutTextIntoBuffer('A\r\nB', atlas, 32, buffer);
    expect(buffer.chars.slice(0, buffer.count)).toEqual(['A', 'B']);
  });
});
