// @vitest-environment jsdom
/**
 * `CodeBlock.getContentProjection()` honouring the per-line hint (CTX-0195).
 *
 * The grid path is where projection DOM concentrates — one carrier per glyph
 * cluster, not per line — so a long code block is the case per-line windowing
 * exists for. These tests pin the two things that are easy to get wrong.
 */
import { describe, expect, it } from 'vitest';
import { CodeBlock, Markdown } from '../src/Markdown';

const SOURCE = Array.from({ length: 200 }, (_, i) => `const value${i} = ${i};`).join('\n');

/**
 * Take the CodeBlock out of a real document rather than constructing one.
 *
 * `CodeBlock`'s constructor needs the resolved `MarkdownTheme` and
 * `DEFAULT_THEME` is module-private, so building one by hand would either pass a
 * hand-written theme (which then drifts from the real default) or reach into
 * internals. Going through `Markdown` also exercises the path a consumer takes.
 */
function codeBlockFrom(source: string): CodeBlock {
  const md = new Markdown(`\`\`\`ts\n${source}\n\`\`\``, { maxWidth: 600 });
  const found = md.content.children.find((c): c is CodeBlock => c instanceof CodeBlock);
  if (!found) throw new Error('no CodeBlock in the rendered document');
  return found;
}

describe('CodeBlock content projection hint', () => {
  it('projects every row when no hint is given', () => {
    const block = codeBlockFrom(SOURCE);
    const proj = block.getContentProjection()!;
    expect(proj.lines).toBeDefined();
    expect(proj.lines!.length).toBe(200);
    // Text is always the whole source: the projection's `text` is the logical
    // document, and `grid.source` must equal it or Scene throws.
    expect(proj.text).toBe(SOURCE);
  });

  it('builds only the rows inside the hint band', () => {
    const block = codeBlockFrom(SOURCE);
    const all = block.getContentProjection()!;
    const lineH = all.lines![1].y - all.lines![0].y;

    // A band covering roughly rows 10..20.
    const minY = all.lines![10].y;
    const maxY = all.lines![20].y;
    const proj = block.getContentProjection({ minY, maxY })!;

    const present = (proj.lines ?? []).filter((l) => l !== undefined);
    expect(present.length).toBeGreaterThan(0);
    expect(present.length).toBeLessThan(200);
    // Every emitted row overlaps the band.
    for (const line of present) {
      expect(line.y + lineH).toBeGreaterThanOrEqual(minY);
      expect(line.y).toBeLessThanOrEqual(maxY);
    }
  });

  it('keeps the lines array INDEX-ALIGNED with the grid rows', () => {
    // Scene's grid path reads `projection.lines[lineIndex]` by DOCUMENT row
    // (Scene.ts:4797). A compacted array would hand row 20's geometry to row 0,
    // so every carrier in a windowed block would be positioned wrong — a silent
    // selection-geometry corruption rather than a crash. The array must therefore
    // stay sparse at full document length.
    const block = codeBlockFrom(SOURCE);
    const all = block.getContentProjection()!;
    const minY = all.lines![10].y;
    const maxY = all.lines![20].y;
    const proj = block.getContentProjection({ minY, maxY })!;

    expect(proj.lines!.length).toBe(200); // full length, holes outside the band
    expect(proj.lines![0]).toBeUndefined(); // row 0 is out of band
    expect(proj.lines![15]).toBeDefined(); // row 15 is in band
    // The in-band entry sits at its own document index, carrying its own y.
    expect(proj.lines![15]!.y).toBe(all.lines![15].y);
    expect(proj.lines![15]!.text).toBe(all.lines![15].text);
  });

  it('still reports the full source text when windowed', () => {
    const block = codeBlockFrom(SOURCE);
    const proj = block.getContentProjection({ minY: 0, maxY: 40 })!;
    // `grid.source must equal ContentProjection.text` is asserted by Scene, and
    // find-in-page/copy semantics depend on the logical text staying whole.
    expect(proj.text).toBe(SOURCE);
    expect(proj.grid?.source).toBe(SOURCE);
  });
});
