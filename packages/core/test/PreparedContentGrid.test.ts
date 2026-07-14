import { describe, expect, it } from 'vitest';
import { prepareContentGrid } from '../src/text/PreparedContentGrid';

describe('prepareContentGrid', () => {
  it('preserves source ranges while assigning terminal-style grid advances', () => {
    const source = 'A\t你👩‍💻1️⃣🇺🇳B';
    const grid = prepareContentGrid(source, {
      font: '15px monospace',
      cellWidth: 10,
      lineHeight: 24,
      baseline: 18,
      tabSize: 4,
    });

    expect(grid.source).toBe(source);
    expect(grid.lines).toHaveLength(1);
    expect(
      grid.lines[0].cells.map((cell) => source.slice(cell.sourceStart, cell.sourceEnd)),
    ).toEqual(['A', '\t', '你', '👩‍💻', '1️⃣', '🇺🇳', 'B']);
    expect(grid.lines[0].cells.map((cell) => cell.advance)).toEqual([10, 30, 20, 20, 20, 20, 10]);
    expect(grid.lines[0].cells[3].sourceCaretOffsets).toEqual([0, '👩‍💻'.length]);
    expect(grid.lines[0].width).toBe(130);
  });

  it('owns hard breaks without normalizing the copied source', () => {
    const source = 'first\n\nlast';
    const grid = prepareContentGrid(source, {
      font: '15px monospace',
      cellWidth: 9,
      lineHeight: 24,
      baseline: 18,
    });

    expect(
      grid.lines.map(({ sourceStart, sourceEnd, nextSourceStart }) => [
        sourceStart,
        sourceEnd,
        nextSourceStart,
      ]),
    ).toEqual([
      [0, 5, 6],
      [6, 6, 7],
      [7, 11, 11],
    ]);
    expect(grid.lines.map((line) => source.slice(line.sourceEnd, line.nextSourceStart))).toEqual([
      '\n',
      '\n',
      '',
    ]);
  });

  it('treats CRLF as one source separator and supplementary CJK as wide', () => {
    const source = 'A𠀀\r\nB';
    const grid = prepareContentGrid(source, {
      font: '15px monospace',
      cellWidth: 10,
      lineHeight: 24,
      baseline: 18,
    });

    expect(grid.lines).toHaveLength(2);
    expect(grid.lines[0].cells.map((cell) => cell.advance)).toEqual([10, 20]);
    expect(source.slice(grid.lines[0].sourceEnd, grid.lines[0].nextSourceStart)).toBe('\r\n');
    expect(
      grid.lines[0].cells.map((cell) => source.slice(cell.sourceStart, cell.sourceEnd)),
    ).toEqual(['A', '𠀀']);
  });

  it('places numeric runs according to mixed-direction Unicode levels', () => {
    const source = 'abc مرحبا 123';
    const grid = prepareContentGrid(source, {
      font: '15px monospace',
      cellWidth: 10,
      lineHeight: 24,
      baseline: 18,
    });
    const visual = [...grid.lines[0].cells]
      .sort((left, right) => left.x - right.x)
      .map((cell) => source.slice(cell.sourceStart, cell.sourceEnd))
      .join('');

    expect(visual).toBe('abc 123 ابحرم');
  });

  it('keeps Arabic source offsets while shaping and visually reordering cells', () => {
    const source = 'لا مرحبا';
    const grid = prepareContentGrid(source, {
      font: '15px monospace',
      cellWidth: 10,
      lineHeight: 24,
      baseline: 18,
    });
    const cells = grid.lines[0].cells;

    expect(source.slice(cells[0].sourceStart, cells[0].sourceEnd)).toBe('لا');
    expect(cells[0].glyph).toMatch(/[\uFE70-\uFEFF]/u);
    expect(cells[0].sourceCaretOffsets).toEqual([0, 1, 2]);
    expect(cells.map((cell) => source.slice(cell.sourceStart, cell.sourceEnd)).join('')).toBe(
      source,
    );
    expect(cells[0].x).toBeGreaterThan(cells.at(-1)!.x);
  });

  it('rejects invalid grid metrics at the module boundary', () => {
    expect(() =>
      prepareContentGrid('text', {
        font: '15px monospace',
        cellWidth: 0,
        lineHeight: 24,
        baseline: 18,
      }),
    ).toThrow(RangeError);
    expect(() =>
      prepareContentGrid('text', {
        font: '15px monospace',
        cellWidth: 10,
        lineHeight: 24,
        baseline: 18,
        tabSize: 0,
      }),
    ).toThrow(RangeError);
  });
});
