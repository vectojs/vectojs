// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Text, RichText, Table, Markdown } from '../src/index';

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
