// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Text, RichText, Table } from '../src/index';

// jsdom has no canvas getContext; measure.ts falls back to its estimate. Stub to
// keep the test output free of "Not implemented" noise.
HTMLCanvasElement.prototype.getContext = (() => null) as never;

/**
 * Native text selection rides on the DOM content projection: the transparent
 * node must mirror the canvas layout exactly (same line breaks, same line
 * height) or the browser's selection/find highlights drift off the drawn
 * glyphs — and it must actually receive the pointer.
 */
describe('selection fidelity of content projections', () => {
  const projectedSource = (projection: NonNullable<ReturnType<Text['getContentProjection']>>) =>
    projection.lines
      ?.map(
        (line) =>
          line.text + ((line as typeof line & { separatorAfter?: string }).separatorAfter ?? ''),
      )
      .join('') ?? projection.text;

  describe('Text', () => {
    it('is not interactive, so its selectable projection receives the pointer', () => {
      // An interactive entity also projects an invisible a11y div with
      // pointer-events: auto ABOVE the content node — it would eat the
      // mousedown and make the text unselectable (RichText already opts out).
      expect(new Text('hello').interactive).toBe(false);
    });

    it('projects visual lines without changing soft-wrap source text', () => {
      const t = new Text('alpha beta gamma delta epsilon zeta eta theta', {
        font: '16px sans-serif',
        maxWidth: 120,
        lineHeight: 28,
      });
      const p = t.getContentProjection()!;
      expect(p).not.toBeNull();
      // The canvas draws lines this.lineHeight apart; the DOM copy must flow
      // at the same advance or multi-line selection drifts vertically.
      expect(p.lineHeight).toBe(28);
      // Visual lines stay independently positioned, but their text plus
      // separators must reconstruct the original logical source exactly.
      const lines = (t as unknown as { lines: string[] }).lines;
      expect(lines.length).toBeGreaterThan(1);
      expect(p.text).toBe(t.text);
      expect(projectedSource(p)).toBe(t.text);
      expect(p.lines).toEqual(
        lines.map((text, index) =>
          expect.objectContaining({
            text,
            x: 0,
            y: index * 28,
            baseline: 28 * 0.8,
            lineHeight: 28,
          }),
        ),
      );
    });

    it('distinguishes hard breaks, soft spaces, and space-less CJK wraps', () => {
      for (const source of [
        'alpha\nbeta',
        'alpha beta gamma delta',
        '甲乙丙丁戊己',
        '\nalpha',
        'alpha\n',
        'alpha\n\nbeta',
        '   ',
      ]) {
        const projection = new Text(source, {
          font: '16px sans-serif',
          maxWidth: 32,
        }).getContentProjection()!;
        expect(projection.lines!.length).toBeGreaterThan(0);
        expect(projection.text).toBe(source);
        expect(projectedSource(projection)).toBe(source);
      }
    });

    it('projects Arabic with embedded LTR text in logical source order', () => {
      const source = 'مرحبا بك في VectoJS';
      const projection = new Text(source, {
        font: '16px serif',
        maxWidth: 120,
      }).getContentProjection()!;
      expect(projection.text).toBe(source);
      expect(projectedSource(projection)).toBe(source);
    });

    it('projects single-line text unchanged', () => {
      const t = new Text('short', { font: '16px sans-serif' });
      expect(t.getContentProjection()!.text).toBe('short');
    });

    it('allows native selection to be disabled and enabled at runtime', () => {
      const t = new Text('optional selection', { selectable: false });
      expect(t.getContentProjection()!.selectable).toBe(false);
      expect(t.setSelectable(true)).toBe(t);
      expect(t.getContentProjection()!.selectable).toBe(true);
    });
  });

  describe('RichText', () => {
    it('projects the engine line advance as lineHeight', () => {
      const rt = new RichText([{ text: 'styled words here' }], {
        font: '16px sans-serif',
      });
      const p = rt.getContentProjection()!;
      // RichText draws at the layout engine's internal advance (fontSize×1.5).
      expect(p.lineHeight).toBe(24);
    });

    it('projects actual wrapped lines without changing logical source text', () => {
      const rt = new RichText([{ text: 'alpha beta gamma delta epsilon' }], {
        font: '16px sans-serif',
        maxWidth: 80,
        selectable: false,
      });
      const projection = rt.getContentProjection()!;
      expect(projection.lines!.length).toBeGreaterThan(1);
      expect(projection.text).toBe('alpha beta gamma delta epsilon');
      expect(projectedSource(projection)).toBe('alpha beta gamma delta epsilon');
      expect(projection.selectable).toBe(false);
      rt.setSelectable(true);
      expect(rt.getContentProjection()!.selectable).toBe(true);
    });

    it('projects mixed-size runs with their rendered font and line baseline', () => {
      const rt = new RichText(
        [{ text: 'base ' }, { text: 'large', style: { bold: true, fontSize: 28 } }],
        { font: '16px sans-serif' },
      );
      const line = rt.getContentProjection()!.lines?.[0];
      expect(line?.baseline).toBeGreaterThan(0);
      // LayoutEngine advances a rich line by its largest font size × 1.5.
      // The DOM line box must retain that same advance for selection geometry.
      expect(line?.lineHeight).toBe(42);
      expect(line?.runs?.find((run) => run.text === 'large')?.font).toContain('28px');
      expect(line?.runs?.find((run) => run.text === 'large')?.font).toContain('bold');
    });

    it('preserves logical mixed-run and RTL source across visual rows', () => {
      const source = 'small office مرحبا VectoJS';
      const rt = new RichText(
        [
          { text: 'small ', style: { fontSize: 12 } },
          { text: 'office ', style: { bold: true } },
          { text: 'مرحبا VectoJS', style: { fontSize: 20 } },
        ],
        { font: '16px serif', maxWidth: 96 },
      );
      const projection = rt.getContentProjection()!;
      expect(projection.lines!.length).toBeGreaterThan(1);
      expect(projection.text).toBe(source);
      expect(projectedSource(projection)).toBe(source);
    });
  });

  describe('Table entity cells', () => {
    it('wraps entity cells to the column width via setMaxWidth', () => {
      const cell = new RichText(
        [{ text: 'a very long table cell that must wrap inside its column' }],
        { font: '14px sans-serif' },
      );
      new Table({ headers: ['h'], rows: [[cell]], width: 200 });
      // Assigning the maxWidth FIELD never reaches the layout engine — only
      // setMaxWidth() re-wraps. The cell must be laid out at colWidth − 24.
      expect(cell.maxWidth).toBe(176);
      expect((cell as unknown as { engine: { maxWidth: number } }).engine.maxWidth).toBe(176);
    });

    it('lays out cells before render and keeps render free of geometry mutations', () => {
      const header = new RichText([{ text: 'Header' }], { font: '14px sans-serif' });
      const first = new RichText([{ text: 'First row' }], { font: '14px sans-serif' });
      const second = new RichText([{ text: 'Second row' }], { font: '14px sans-serif' });
      const table = new Table({ headers: [header], rows: [[first], [second]], width: 180 });
      const before = [header.x, header.y, first.x, first.y, second.x, second.y, table.height];

      expect(first.y).toBeGreaterThan(header.y);
      expect(second.y).toBeGreaterThan(first.y);
      table.render({
        beginPath() {},
        roundRect() {},
        fill() {},
        moveTo() {},
        lineTo() {},
        stroke() {},
      } as never);

      expect([header.x, header.y, first.x, first.y, second.x, second.y, table.height]).toEqual(
        before,
      );
    });

    it('reflows row and table geometry after a cell changes', () => {
      const first = new RichText([{ text: 'short' }], { font: '14px sans-serif' });
      const second = new RichText([{ text: 'next' }], { font: '14px sans-serif' });
      const table = new Table({ headers: ['Header'], rows: [[first], [second]], width: 140 });
      const oldHeight = table.height;
      const oldSecondY = second.y;

      first.setSpans([{ text: 'A long unbroken中文内容需要在列宽以内自动换行并增加行高' }]);
      table.layout();

      expect(first.width).toBeLessThanOrEqual(116);
      expect(table.rowHeights[0]).toBeGreaterThan(36);
      expect(table.height).toBeGreaterThan(oldHeight);
      expect(second.y).toBeGreaterThan(oldSecondY);
    });

    it('gives every logical cell one child projection instead of aggregating duplicates', () => {
      const table = new Table({
        headers: ['A', 'B'],
        rows: [['one', 'two']],
        width: 240,
        selectable: false,
      });
      expect(table.getContentProjection()).toBeNull();
      expect(
        table.children.map((cell) => cell.getContentProjection()?.text).filter(Boolean),
      ).toEqual(['A', 'B', 'one', 'two']);
      expect(
        table.children.every((cell) => cell.getContentProjection()?.selectable === false),
      ).toBe(true);
    });

    it('updates normalized string cells on layout and ignores malformed overflow cells', () => {
      const overflow = new RichText([{ text: 'must not become a ghost cell' }]);
      const rows: Array<Array<string | RichText>> = [['before', overflow]];
      const table = new Table({ headers: ['H'], rows, width: 160 });
      expect(overflow.parent).toBeNull();
      expect(table.children).toHaveLength(2);

      rows[0][0] = 'after';
      table.layout();
      expect(table.children[1].getContentProjection()?.text).toBe('after');
    });
  });
});
