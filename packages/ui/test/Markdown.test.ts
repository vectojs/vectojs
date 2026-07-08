// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import type { Tokens } from 'marked';
import { CodeBlock, Markdown } from '../src/Markdown';
import { RichText } from '../src/RichText';
import { Text } from '../src/Text';

function clickFirstLink(entity: RichText): void {
  expect(entity.children.length).toBeGreaterThan(0);
  entity.children[0].emit('click', {});
}

describe('Markdown', () => {
  it('creates child entities from heading tokens', () => {
    const md = new Markdown('# Hello World');
    expect(md.content.children.length).toBeGreaterThanOrEqual(1);
    expect(md.width).toBeGreaterThan(0);
    expect(md.height).toBeGreaterThan(0);
  });

  it('renders paragraphs', () => {
    const md = new Markdown('This is a paragraph.\n\nAnother paragraph.');
    // Two paragraphs → at least 2 children
    expect(md.content.children.length).toBeGreaterThanOrEqual(2);
  });

  it('renders code blocks with background', () => {
    const code = '```js\nconst x = 1;\nconsole.log(x);\n```';
    const md = new Markdown(code);
    expect(md.content.children.length).toBeGreaterThanOrEqual(1);
    // CodeBlock is a single leaf entity — no child sub-tree
    const codeBlock = md.content.children[0];
    expect(codeBlock.children.length).toBe(0);
  });

  it('renders unordered lists with bullets', () => {
    const md = new Markdown('- Item A\n- Item B\n- Item C');
    expect(md.content.children.length).toBeGreaterThanOrEqual(1);
    const list = md.content.children[0];
    expect(list.children.length).toBe(3);
  });

  it('renders ordered lists with numbers', () => {
    const md = new Markdown('1. First\n2. Second\n3. Third');
    expect(md.content.children.length).toBeGreaterThanOrEqual(1);
  });

  it('renders blockquotes with border', () => {
    const md = new Markdown('> This is a quote');
    expect(md.content.children.length).toBeGreaterThanOrEqual(1);
    const bq = md.content.children[0];
    expect(bq.children.length).toBeGreaterThanOrEqual(1);
  });

  it('overlays the blockquote border and text at the same position, not stacked sequentially', () => {
    const md = new Markdown('> This is a quote');
    const bq = md.content.children[0] as unknown as {
      height: number;
      children: { y: number; height: number }[];
    };
    const [border, innerStack] = bq.children;
    // Both children are meant to overlay at the top of the blockquote box, not
    // be laid out one after another — the border is a left rule running the
    // full height of the quote, drawn behind/alongside the text, not above it.
    expect(border.y).toBe(0);
    expect(innerStack.y).toBe(0);
    // The container's reported height must actually bound its children —
    // otherwise the text renders outside the box the parent layout thinks
    // this blockquote occupies.
    expect(bq.height).toBeGreaterThanOrEqual(innerStack.height);
    expect(bq.height).toBeGreaterThanOrEqual(border.height);
  });

  it('renders horizontal rules', () => {
    const md = new Markdown('---');
    expect(md.content.children.length).toBeGreaterThanOrEqual(1);
  });

  it('skips whitespace tokens', () => {
    const md = new Markdown('\n\n\n');
    // Only whitespace → no children
    expect(md.content.children.length).toBe(0);
  });

  it('accepts custom theme', () => {
    const md = new Markdown('# Hello', {
      theme: { headingColor: '#ff0000', fontSize: 20 },
    });
    expect(md.theme.headingColor).toBe('#ff0000');
    expect(md.theme.fontSize).toBe(20);
    // Default values still present
    expect(md.theme.textColor).toBe('#e2e8f0');
  });

  it('accepts custom maxWidth', () => {
    const md = new Markdown('Hello', { maxWidth: 400 });
    expect(md.maxWidth).toBe(400);
  });

  it('renders code blocks as a single CodeBlock entity (not N×M children)', () => {
    const code = '```js\nconst x = 1;\nlet y = 2;\nreturn x + y;\n```';
    const md = new Markdown(code);
    const codeBlock = md.content.children[0];
    // Should be a single entity, not a Container with nested Stacks
    expect(codeBlock.children.length).toBe(0); // No sub-entities
    expect(codeBlock.height).toBeGreaterThan(0);
    expect(codeBlock.width).toBeGreaterThan(0);
  });

  it('does not double-decode escaped HTML entities', () => {
    const md = new Markdown('Escaped entity: &amp;lt;tag&amp;gt; and real entity: &lt;ok&gt;');
    const paragraph = md.content.children[0] as RichText;
    const text = paragraph.spans.map((span) => span.text).join('');

    expect(text).toBe('Escaped entity: &lt;tag&gt; and real entity: <ok>');
  });

  it('positions CodeBlock highlight segments by source columns, not token widths', () => {
    const theme = {
      textColor: '#e2e8f0',
      headingColor: '#f8fafc',
      codeColor: '#a5f3fc',
      codeBgColor: 'rgba(30, 41, 59, 0.85)',
      quoteBorderColor: '#6366f1',
      quoteTextColor: '#94a3b8',
      hrColor: 'rgba(148, 163, 184, 0.3)',
      bodyFont: 'Inter, system-ui, sans-serif',
      codeFont: '"JetBrains Mono", "Fira Code", monospace',
      fontSize: 16,
    };
    const block = new CodeBlock('const scene = new Scene(canvas);', 'ts', 400, theme);
    const rendered: Array<{ text: string; x: number }> = [];
    const renderer = {
      beginPath() {},
      roundRect() {},
      fill() {},
      fillText(text: string, x: number) {
        rendered.push({ text, x });
      },
    };

    (block as unknown as { cellWidth: number }).cellWidth = 10;
    block.render(renderer as any);

    const base = rendered.find((call) => call.text === 'const')!.x;
    expect(rendered.find((call) => call.text === 'scene')!.x - base).toBe(60);
    expect(rendered.find((call) => call.text === 'new')!.x - base).toBe(140);
    expect(rendered.find((call) => call.text === 'Scene')!.x - base).toBe(180);
  });

  it('handles complex markdown without throwing', () => {
    const complexMd = `
# Title

Some **bold** and *italic* text.

## Subtitle

- List item 1
- List item 2

> A blockquote with some text

\`\`\`typescript
const greeting: string = "Hello";
function greet() {
  return greeting;
}
\`\`\`

---

1. Ordered item
2. Another item

Plain paragraph at the end.
`;
    expect(() => new Markdown(complexMd)).not.toThrow();
    const md = new Markdown(complexMd);
    expect(md.content.children.length).toBeGreaterThan(5);
  });

  // ── Inline style tests (RichText integration) ──────────────────────────

  it('renders bold inline text as RichText with bold spans', () => {
    const md = new Markdown('This is **bold** text.');
    const paragraph = md.content.children[0];
    expect(paragraph).toBeInstanceOf(RichText);
  });

  it('renders italic inline text as RichText with italic spans', () => {
    const md = new Markdown('This is *italic* text.');
    const paragraph = md.content.children[0];
    expect(paragraph).toBeInstanceOf(RichText);
    // The RichText should have spans with italic style
    const rt = paragraph as RichText;
    const italicSpan = rt.spans.find((s) => s.style?.italic);
    expect(italicSpan).toBeDefined();
    expect(italicSpan!.text).toBe('italic');
  });

  it('renders inline code with code styling', () => {
    const md = new Markdown('Use `console.log` here.');
    const paragraph = md.content.children[0];
    expect(paragraph).toBeInstanceOf(RichText);
    const rt = paragraph as RichText;
    const codeSpan = rt.spans.find((s) => s.text === 'console.log');
    expect(codeSpan).toBeDefined();
  });

  it('renders links with href in spans', () => {
    const md = new Markdown('Visit [Google](https://google.com) now.');
    const paragraph = md.content.children[0];
    expect(paragraph).toBeInstanceOf(RichText);
    const rt = paragraph as RichText;
    const linkSpan = rt.spans.find((s) => s.style?.href);
    expect(linkSpan).toBeDefined();
    expect(linkSpan!.style!.href).toBe('https://google.com');
    expect(linkSpan!.text).toBe('Google');
  });

  it('forwards onLinkClick from paragraph links', () => {
    const clicked: string[] = [];
    const md = new Markdown('Visit [Docs](https://vectojs.org) now.', {
      onLinkClick: (href) => clicked.push(href),
    });

    clickFirstLink(md.content.children[0] as RichText);
    expect(clicked).toEqual(['https://vectojs.org']);
  });

  it('forwards onLinkClick from heading links', () => {
    const clicked: string[] = [];
    const md = new Markdown('# [Docs](https://vectojs.org)', {
      onLinkClick: (href) => clicked.push(href),
    });

    clickFirstLink(md.content.children[0] as RichText);
    expect(clicked).toEqual(['https://vectojs.org']);
  });

  it('forwards onLinkClick from list item links', () => {
    const clicked: string[] = [];
    const md = new Markdown('- [Docs](https://vectojs.org)', {
      onLinkClick: (href) => clicked.push(href),
    });
    const list = md.content.children[0];

    clickFirstLink(list.children[0] as RichText);
    expect(clicked).toEqual(['https://vectojs.org']);
  });

  it('allows subclasses to override renderToken for custom Markdown renderers', () => {
    class CustomMarkdown extends Markdown {
      protected override renderToken(token: Tokens.Generic) {
        if (token.type === 'paragraph') {
          return new Text('custom paragraph', { font: '16px sans-serif' });
        }
        return super.renderToken(token);
      }
    }

    const md = new CustomMarkdown('Original text');
    expect(md.content.children[0]).toBeInstanceOf(Text);
    expect((md.content.children[0] as Text).text).toBe('custom paragraph');
  });

  // ── Streaming / Mutation tests ──────────────────────────────────────────

  describe('Markdown streaming', () => {
    it('setContent replaces all children', () => {
      const md = new Markdown('# Hello');
      expect(md.content.children.length).toBeGreaterThanOrEqual(1);
      md.setContent('# Goodbye\n\nNew paragraph.');
      // Should have new content
      expect(md.content.children.length).toBeGreaterThanOrEqual(2);
    });

    it('appendMarkdown adds new block-level tokens', () => {
      const md = new Markdown('# Title');
      const initialCount = md.content.children.length;
      md.appendMarkdown('\n\nNew paragraph added.');
      expect(md.content.children.length).toBeGreaterThan(initialCount);
    });

    it('appendMarkdown reuses unchanged prefix entities', () => {
      const md = new Markdown('# Title\n\nFirst paragraph.');
      const firstChild = md.content.children[0]; // heading
      md.appendMarkdown('\n\nSecond paragraph.');
      // The heading entity should be the same object (reused, not recreated)
      expect(md.content.children[0]).toBe(firstChild);
    });

    it('appendMarkdown updates last paragraph in-place when it grows', () => {
      const md = new Markdown('Hello');
      const para = md.content.children[0];
      md.appendMarkdown(' world');
      // The paragraph entity should be updated in place (same reference)
      expect(md.content.children[0]).toBe(para);
    });

    it('handles incomplete code fences without crashing', () => {
      const md = new Markdown('Some text');
      expect(() => md.appendMarkdown('\n\n```js\nconst x = 1;')).not.toThrow();
      // The incomplete fence might be treated as text or partial code
      expect(md.content.children.length).toBeGreaterThanOrEqual(1);
    });
    it('renders tables using the Table component', () => {
      const tableMd = `
| Header 1 | Header 2 |
|----------|----------|
| Row 1-1  | Row 1-2  |
| Row 2-1  | Row 2-2  |
`;
      const md = new Markdown(tableMd);
      expect(md.content.children.length).toBeGreaterThanOrEqual(1);
      const table = md.content.children[0];

      // Verify that it is indeed a Table component instance
      expect(table.constructor.name).toBe('Table');
      expect((table as any).headers).toEqual(['Header 1', 'Header 2']);
      expect((table as any).rows).toEqual([
        ['Row 1-1', 'Row 1-2'],
        ['Row 2-1', 'Row 2-2'],
      ]);
    });
  });
});
