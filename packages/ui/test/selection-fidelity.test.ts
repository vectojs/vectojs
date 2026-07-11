// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { CodeBlock, Text, RichText, Table, Markdown } from '../src/index';

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
  describe('Text', () => {
    it('is not interactive, so its selectable projection receives the pointer', () => {
      // An interactive entity also projects an invisible a11y div with
      // pointer-events: auto ABOVE the content node — it would eat the
      // mousedown and make the text unselectable (RichText already opts out).
      expect(new Text('hello').interactive).toBe(false);
    });

    it('projects the rendered lines and the drawn lineHeight', () => {
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
      // Contract: "the plain text content as rendered (line breaks as \n)" —
      // the projection carries the engine's actual wrap points so the browser
      // cannot re-wrap differently than the canvas did.
      const lines = (t as unknown as { lines: string[] }).lines;
      expect(lines.length).toBeGreaterThan(1);
      expect(p.text).toBe(lines.join('\n'));
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

    it('projects actual wrapped lines and exposes the selectable setting', () => {
      const rt = new RichText([{ text: 'alpha beta gamma delta epsilon' }], {
        font: '16px sans-serif',
        maxWidth: 80,
        selectable: false,
      });
      const projection = rt.getContentProjection()!;
      expect(projection.text).toContain('\n');
      expect(projection.selectable).toBe(false);
      rt.setSelectable(true);
      expect(rt.getContentProjection()!.selectable).toBe(true);
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

  describe('Markdown projection propagation', () => {
    const descendants = (root: { children: unknown[] }): Array<{ children: unknown[] }> => {
      const result: Array<{ children: unknown[] }> = [];
      for (const child of root.children as Array<{ children: unknown[] }>) {
        result.push(child, ...descendants(child));
      }
      return result;
    };

    it('propagates selectable through headings, body, tables, code, and runtime changes', () => {
      const md = new Markdown(
        '# Heading\n\nBody text\n\n```ts\nconst answer = 42;\n```\n\n| H |\n| - |\n| cell |',
        { selectable: false, maxWidth: 240 },
      );
      const projected = descendants(md as unknown as { children: unknown[] })
        .map((entity) =>
          (
            entity as unknown as { getContentProjection(): { selectable?: boolean } | null }
          ).getContentProjection(),
        )
        .filter((projection): projection is { selectable?: boolean } => projection !== null);
      expect(projected.length).toBeGreaterThan(3);
      expect(projected.every((projection) => projection.selectable === false)).toBe(true);

      md.setSelectable(true);
      expect(
        descendants(md as unknown as { children: unknown[] })
          .map((entity) =>
            (
              entity as unknown as { getContentProjection(): { selectable?: boolean } | null }
            ).getContentProjection(),
          )
          .filter((projection): projection is { selectable?: boolean } => projection !== null)
          .every((projection) => projection.selectable === true),
      ).toBe(true);
    });

    it('projects fenced code exactly once with its source line breaks', () => {
      const md = new Markdown('```ts\nconst answer = 42;\nconsole.log(answer);\n```', {
        selectable: true,
      });
      const code = descendants(md as unknown as { children: unknown[] }).find(
        (entity) => entity instanceof CodeBlock,
      ) as CodeBlock;
      expect(code).toBeDefined();
      expect(code.getContentProjection()).toMatchObject({
        text: 'const answer = 42;\nconsole.log(answer);',
        selectable: true,
      });
    });

    it('styles table headers as bold heading text', () => {
      const md = new Markdown('| Header |\n| --- |\n| body |', {
        theme: { headingColor: '#ff00aa', textColor: '#112233' },
      });
      const table = descendants(md as unknown as { children: unknown[] }).find(
        (entity) => entity instanceof Table,
      ) as Table;
      const header = table.headers[0] as RichText;
      expect((header as unknown as { baseStyle?: { bold?: boolean } }).baseStyle?.bold).toBe(true);
      expect(header.color).toBe('#ff00aa');
    });
  });

  describe('Markdown table line breaks', () => {
    const cellRichText = (md: Markdown): RichText => {
      const findTable = (e: { children: unknown[] }): Table | null => {
        for (const c of e.children as Array<{ children: unknown[] }>) {
          if (c instanceof Table) return c;
          const nested = findTable(c);
          if (nested) return nested;
        }
        return null;
      };
      const table = findTable(md as unknown as { children: unknown[] })!;
      expect(table).not.toBeNull();
      const cell = table.rows[0][0];
      expect(cell).toBeInstanceOf(RichText);
      return cell as RichText;
    };

    it('renders <br> in a table cell as a line break, not literal text', () => {
      const md = new Markdown('| h |\n| --- |\n| first<br>second |', { maxWidth: 400 });
      const text = cellRichText(md).getContentProjection()!.text;
      expect(text).not.toContain('<br');
      expect(text).toContain('first\nsecond');
    });

    it('supports self-closing and spaced br variants', () => {
      const md = new Markdown('| h |\n| --- |\n| a<br/>b<br />c |', { maxWidth: 400 });
      const text = cellRichText(md).getContentProjection()!.text;
      expect(text).toBe('a\nb\nc');
    });

    it('does not print other inline html tags as text', () => {
      const md = new Markdown('| h |\n| --- |\n| x<span>y</span>z |', { maxWidth: 400 });
      const text = cellRichText(md).getContentProjection()!.text;
      expect(text).not.toContain('<span>');
      expect(text).toContain('x');
      expect(text).toContain('y');
      expect(text).toContain('z');
    });

    it('honours markdown hard breaks (br tokens) in paragraphs', () => {
      const md = new Markdown('line one\\\nline two', { maxWidth: 400 });
      const findRichText = (e: { children: unknown[] }): RichText | null => {
        for (const c of e.children as Array<{ children: unknown[] }>) {
          if (c instanceof RichText) return c;
          const nested = findRichText(c);
          if (nested) return nested;
        }
        return null;
      };
      const rt = findRichText(md as unknown as { children: unknown[] })!;
      expect(rt).not.toBeNull();
      expect(rt.getContentProjection()!.text).toBe('line one\nline two');
    });
  });
});
