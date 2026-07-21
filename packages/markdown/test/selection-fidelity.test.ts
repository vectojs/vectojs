// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { CodeBlock, Markdown } from '../src/Markdown';
import { RichText, Table } from '@vectojs/ui';

// jsdom has no canvas getContext; measure.ts falls back to its estimate. Stub to
// keep the test output free of "Not implemented" noise.
HTMLCanvasElement.prototype.getContext = (() => null) as never;

/**
 * Native text selection rides on the DOM content projection: the transparent
 * node must mirror the canvas layout exactly. These cases cover the Markdown
 * entity and CodeBlock (moved out of @vectojs/ui into @vectojs/markdown), whose
 * projections must propagate selectable state and preserve source line breaks.
 */
describe('Markdown selection fidelity', () => {
  const projectedSource = (projection: { lines?: unknown[]; text: string }) =>
    (projection.lines as Array<{ text: string; separatorAfter?: string }> | undefined)
      ?.map((line) => line.text + (line.separatorAfter ?? ''))
      .join('') ?? projection.text;

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
      expect(projectedSource(code.getContentProjection()!)).toBe(
        'const answer = 42;\nconsole.log(answer);',
      );
    });

    it('keeps list items and Markdown table cells selectable once in VMT order', () => {
      const md = new Markdown(
        '- Item A\n- Item B\n\n1. First\n2. Second\n\n| Name | Value |\n| --- | --- |\n| Alpha | 1 |',
        { maxWidth: 400, selectable: true },
      );
      const text = descendants(md as unknown as { children: unknown[] })
        .filter((entity) => entity instanceof RichText)
        .map((entity) => (entity as RichText).getContentProjection()!.text);
      expect(text).toEqual([
        '• Item A',
        '• Item B',
        '1. First',
        '2. Second',
        'Name',
        'Value',
        'Alpha',
        '1',
      ]);
    });

    it('projects each fenced-code row from the same inset and baseline as canvas', () => {
      const code = new CodeBlock('const answer = 42;', 'ts', 400, {
        textColor: '#e2e8f0',
        headingColor: '#f8fafc',
        codeColor: '#a5f3fc',
        codeBgColor: '#0f172a',
        quoteBorderColor: '#6366f1',
        quoteTextColor: '#94a3b8',
        hrColor: '#334155',
        tableBgColor: '#0f172a',
        tableHeaderBgColor: '#1e293b',
        bodyFont: 'sans-serif',
        codeFont: 'monospace',
        fontSize: 16,
      });
      const projection = code.getContentProjection()!;
      expect(projection.lines).toEqual([
        expect.objectContaining({ text: 'const answer = 42;', x: 18, y: 18, baseline: 18 }),
      ]);
    });

    it('owns each hard newline on the preceding CodeBlock row', () => {
      const code = new CodeBlock('const a = 1;\nconsole.log(a);', 'ts', 400, {
        textColor: '#e2e8f0',
        headingColor: '#f8fafc',
        codeColor: '#a5f3fc',
        codeBgColor: '#0f172a',
        quoteBorderColor: '#6366f1',
        quoteTextColor: '#94a3b8',
        hrColor: '#334155',
        tableBgColor: '#0f172a',
        tableHeaderBgColor: '#1e293b',
        bodyFont: 'sans-serif',
        codeFont: 'monospace',
        fontSize: 16,
      });
      const lines = code.getContentProjection()!.lines!;
      expect(
        (lines[0] as (typeof lines)[number] & { separatorAfter?: string }).separatorAfter,
      ).toBe('\n');
      expect(
        (lines[1] as (typeof lines)[number] & { separatorAfter?: string }).separatorAfter,
      ).toBeUndefined();
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
