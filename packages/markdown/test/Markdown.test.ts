// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import type { Tokens } from 'marked';
import { lexer as markedLexer } from 'marked';
import { CodeBlock, Markdown } from '../src/Markdown';
import { RichText, Text } from '@vectojs/ui';

function clickFirstLink(entity: RichText): void {
  expect(entity.children.length).toBeGreaterThan(0);
  entity.children[0].emit('click', {});
}

const CODE_THEME = {
  textColor: '#e2e8f0',
  headingColor: '#f8fafc',
  codeColor: '#a5f3fc',
  codeBgColor: 'rgba(30, 41, 59, 0.85)',
  quoteBorderColor: '#6366f1',
  quoteTextColor: '#94a3b8',
  hrColor: 'rgba(148, 163, 184, 0.3)',
  tableBgColor: 'rgba(15, 15, 25, 0.4)',
  tableHeaderBgColor: 'rgba(30, 41, 59, 0.85)',
  bodyFont: 'Inter, system-ui, sans-serif',
  codeFont: '"JetBrains Mono", "Fira Code", monospace',
  fontSize: 16,
};

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

  describe('list marker side follows item reading direction', () => {
    // Each list item is a RichText; its first/last span text carries the marker.
    const itemSpans = (md: Markdown, i: number) => {
      const list = md.content.children[0] as { children: any[] };
      return (list.children[i] as { spans: { text: string }[] }).spans;
    };

    it('LTR unordered item keeps the bullet as a LEADING span', () => {
      const md = new Markdown('- hello world');
      const spans = itemSpans(md, 0);
      expect(spans[0].text).toBe('• ');
      expect(spans[spans.length - 1].text).not.toContain('\u2022');
    });

    it('RTL unordered item puts the bullet as a TRAILING span (visual right)', () => {
      // Arabic item — the marker must trail so it reorders to the reading-start
      // (right) side instead of the visual left.
      const md = new Markdown('- \u0639\u0631\u0628\u064a');
      const spans = itemSpans(md, 0);
      expect(spans[0].text).not.toContain('\u2022'); // NOT leading
      expect(spans[spans.length - 1].text).toBe(' \u2022'); // trailing marker
    });

    it('RTL ordered item trails a reversed " .N" marker', () => {
      const md = new Markdown('1. \u0639\u0631\u0628\u064a');
      const spans = itemSpans(md, 0);
      expect(spans[0].text).not.toMatch(/^\d/); // number is NOT leading
      expect(spans[spans.length - 1].text).toBe(' .1'); // reorders to "1. …"
    });

    it('LTR ordered item keeps the "N. " number leading', () => {
      const md = new Markdown('1. first\n2. second');
      expect(itemSpans(md, 0)[0].text).toBe('1. ');
      expect(itemSpans(md, 1)[0].text).toBe('2. ');
    });
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

  it('lays blockquote descendants inside the available width', () => {
    const md = new Markdown('> A long quoted paragraph that wraps across lines.', {
      maxWidth: 120,
    });
    const blockquote = md.content.children[0];
    const innerStack = blockquote.children[1];
    const wrapper = innerStack.children[0];
    const paragraph = wrapper.children[0] as RichText;

    expect(paragraph).toBeInstanceOf(RichText);
    expect(paragraph.maxWidth).toBe(104);
    expect(paragraph.x + paragraph.width).toBeLessThanOrEqual(blockquote.width);
    expect(wrapper.width).toBeLessThanOrEqual(blockquote.width);
  });

  it('composes nested blockquote indentation without widening either container', () => {
    const md = new Markdown('> > A nested quoted paragraph that wraps across lines.', {
      maxWidth: 120,
    });
    const outer = md.content.children[0];
    const outerStack = outer.children[1];
    const outerWrapper = outerStack.children[0];
    const nested = outerWrapper.children[0];
    const nestedStack = nested.children[1];
    const nestedWrapper = nestedStack.children[0];
    const paragraph = nestedWrapper.children[0] as RichText;

    expect(outer.width).toBe(120);
    expect(nested.width).toBe(104);
    expect(paragraph.maxWidth).toBe(88);
    expect(outerWrapper.width).toBeLessThanOrEqual(outer.width);
    expect(nestedWrapper.width).toBeLessThanOrEqual(nested.width);
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
    const block = new CodeBlock('const scene = new Scene(canvas);', 'ts', 400, CODE_THEME);
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

    // Cell-by-cell drawing: source column × cellWidth, one call per cluster.
    const source = 'const scene = new Scene(canvas);';
    const base = rendered[0].x;
    for (const call of rendered) {
      const col = (call.x - base) / 10;
      expect(Number.isInteger(col)).toBe(true);
      expect(source[col]).toBe(call.text);
    }
    // Every non-space character is drawn — 'scene' starts at column 6,
    // 'Scene' at column 18 — and nothing else is.
    const textAtCol = (col: number) => rendered.find((call) => call.x - base === col * 10)?.text;
    expect(textAtCol(6)).toBe('s');
    expect(textAtCol(18)).toBe('S');
    expect(rendered.length).toBe(source.replace(/ /g, '').length);
  });

  it('draws CodeBlock text one grapheme cluster per fillText, never whole runs', () => {
    // 'office' is the classic ffi-ligature victim: Firefox Canvas2D ligates it
    // inside a single fillText run and the glyphs leave the monospace grid.
    // Per-cluster calls make ligature formation impossible in any browser.
    const block = new CodeBlock('const office = "ffi affinity";', 'ts', 400, CODE_THEME);
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

    for (const call of rendered) {
      expect([...call.text].length).toBe(1);
    }
    // Spaces advance the column but are never drawn.
    expect(rendered.some((call) => call.text === ' ')).toBe(false);
    // 'office' occupies columns 6..11 exactly.
    const base = rendered[0].x;
    const officeCalls = rendered.filter(
      (call) => (call.x - base) / 10 >= 6 && (call.x - base) / 10 <= 11,
    );
    expect(officeCalls.map((call) => call.text).join('')).toBe('office');
  });

  it('advances two grid cells for wide CJK clusters so following tokens do not overlap', () => {
    const block = new CodeBlock('// 你好 world', 'ts', 400, CODE_THEME);
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

    const base = rendered[0].x;
    const colOf = (text: string) => (rendered.find((call) => call.text === text)!.x - base) / 10;
    // '//' at 0,1; space at 2; 你 at 3 (wide → 2 cells); 好 at 5; space at 7; 'world' from 8.
    expect(colOf('你')).toBe(3);
    expect(colOf('好')).toBe(5);
    expect(colOf('w')).toBe(8);
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
    // Inline code carries a monospace fontFamily so it renders (and measures)
    // as mono, not just tinted proportional prose.
    expect(codeSpan?.style?.fontFamily).toContain('monospace');
    // A plain prose run in the same paragraph has no family override.
    const proseSpan = rt.spans.find((s) => s.text.includes('Use'));
    expect(proseSpan?.style?.fontFamily).toBeUndefined();
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

    it('reconciles identically whether matchLen is supplied or re-derived', () => {
      // The worker hands over the prefix length it already computed, so the main
      // thread no longer re-scans every token's `raw`. The reconciliation result
      // must be indistinguishable either way — this is the guard that the
      // shortcut is a shortcut and not a behaviour change.
      const build = (supply: boolean) => {
        const md = new Markdown('# Title\n\nFirst.');
        const anyMd = md as unknown as {
          updateTokens: (t: unknown, m?: number) => void;
          tokens: unknown[];
        };
        const originalUpdate = anyMd.updateTokens.bind(anyMd);
        if (!supply) {
          // Force the re-derivation path by withholding the hint.
          anyMd.updateTokens = (t: unknown) => originalUpdate(t);
        }
        md.appendMarkdown('\n\nSecond.');
        md.appendMarkdown(' Third.');
        return md.content.children.length;
      };
      expect(build(true)).toBe(build(false));
    });

    it('ignores an out-of-range matchLen and still reconciles correctly', () => {
      // A hint longer than either token array would make the prefix slice reuse
      // entities that do not correspond to the new tokens. Assert the OUTCOME —
      // that the rendered blocks match an honest reconcile — rather than merely
      // that nothing throws, which passes with or without the guard.
      const honest = new Markdown('# Title\n\nFirst.\n\nSecond.');
      const expected = honest.content.children.length;

      const md = new Markdown('# Title\n\nFirst.');
      const anyMd = md as unknown as {
        updateTokens: (tokens: unknown, matchLen?: number) => void;
      };
      const newTokens = markedLexer('# Title\n\nFirst.\n\nSecond.');
      anyMd.updateTokens(newTokens, 9999);

      expect(md.content.children.length).toBe(expected);
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

    it('updates a growing unclosed code block in-place', () => {
      // An unclosed fenced block is the second most common shape an LLM streams,
      // and the worst case for the rebuild path: CodeBlock re-tokenizes and
      // re-measures its whole grid on construction, so a block growing one line
      // per chunk paid that every time.
      const md = new Markdown('```ts\nconst a = 1;');
      const block = md.content.children[md.content.children.length - 1];

      md.appendMarkdown('\nconst b = 2;');
      expect(md.content.children[md.content.children.length - 1]).toBe(block);

      md.appendMarkdown('\nconst c = 3;');
      expect(md.content.children[md.content.children.length - 1]).toBe(block);
    });

    it('keeps the reused code block content correct as it grows', () => {
      const md = new Markdown('```ts\nline1');
      md.appendMarkdown('\nline2');
      md.appendMarkdown('\nline3');

      const block = md.content.children[md.content.children.length - 1] as unknown as {
        source: string;
      };
      // Reuse must not mean stale: the projected source has to reflect every chunk,
      // or selection and screen-reader text lag the canvas.
      expect(block.source).toContain('line1');
      expect(block.source).toContain('line3');
    });

    it('produces the same highlighted lines whether streamed or set at once', () => {
      // buildLines reuses the highlight of the unchanged line prefix, so the
      // incremental result must be identical to a from-scratch build — otherwise
      // the optimisation trades correctness for speed.
      const streamed = new Markdown('```ts\nconst a = 1;');
      streamed.appendMarkdown('\n// note "x"');
      streamed.appendMarkdown('\nconst b = 2;');

      const atOnce = new Markdown('```ts\nconst a = 1;\n// note "x"\nconst b = 2;');

      const linesOf = (md: Markdown): string =>
        JSON.stringify(
          (
            md.content.children[md.content.children.length - 1] as unknown as {
              lines: unknown;
            }
          ).lines,
        );
      expect(linesOf(streamed)).toBe(linesOf(atOnce));
    });

    it('re-highlights the line a chunk lands mid-way through', () => {
      // A chunk usually arrives mid-line, so the previous last line changes and
      // must NOT be reused — reusing it would leave a half-tokenized line.
      const md = new Markdown('```ts\nconst s = "unclo');
      md.appendMarkdown('sed";');

      const block = md.content.children[md.content.children.length - 1] as unknown as {
        lines: unknown[];
        source: string;
      };
      // One line, not two: the chunk continued the existing line rather than
      // adding one, which is exactly the case the prefix reuse must not treat as
      // stable.
      expect(block.source).toContain('"unclosed"');
      expect(block.lines).toHaveLength(1);
      // And it must be fully re-tokenized, not left as the half-open string.
      expect(JSON.stringify(block.lines)).toContain('unclosed');
    });

    it('picks up a language that arrives after the fence opens', () => {
      // ```` ``` ```` can stream before its info string, so the language is not
      // stable across chunks and must be passed through on every update.
      const md = new Markdown('```\nplain');
      md.setContent('```ts\nplain');
      const block = md.content.children[md.content.children.length - 1] as unknown as {
        lang: string;
      };
      expect(block.lang).toBe('ts');
    });

    it('rebuilds rather than reuses when the block type changes', () => {
      // paragraph -> code is a different entity class; reusing here would be a
      // type error waiting to happen, so the branch must not fire.
      const md = new Markdown('some text');
      const para = md.content.children[0];
      md.setContent('```ts\nsome text');
      expect(md.content.children[0]).not.toBe(para);
    });

    it('keeps content/container size correct when a growing last paragraph is the only change (O(1) resize path)', () => {
      const md = new Markdown('# Title\n\nFirst paragraph.');
      const heading = md.content.children[0];
      const para = md.content.children[1];
      const headingY = para.y;

      // Grow the last paragraph across several appends, as a real stream
      // would, without any new block-level token appearing.
      for (let i = 0; i < 20; i++) {
        md.appendMarkdown(' more and more streamed words to force wrapping');
      }

      // Earlier sibling untouched, container resized to match the grown
      // paragraph exactly (this is what the removed unconditional
      // `content.layout()` call used to guarantee via a full O(children)
      // walk on every single append; resizeLastChild() must match it).
      expect(md.content.children[0]).toBe(heading);
      expect(para.y).toBe(headingY);
      expect(md.content.height).toBe(para.y + para.height);
      expect(md.height).toBe(md.content.height);
      expect(md.width).toBe(md.content.width);
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
      expect((table as any).headers.map((h: any) => (h.spans ? h.spans[0].text : h))).toEqual([
        'Header 1',
        'Header 2',
      ]);
      expect(
        (table as any).rows.map((row: any) =>
          row.map((cell: any) => (cell.spans ? cell.spans[0].text : cell)),
        ),
      ).toEqual([
        ['Row 1-1', 'Row 1-2'],
        ['Row 2-1', 'Row 2-2'],
      ]);
    });

    describe('incremental reconcile equals a full rebuild (token→child prefix cache)', () => {
      // `updateTokens` maps a token index to its child-entity slot through a
      // CACHED prefix sum (rebuilt only for the changed suffix). A stale entry
      // would silently destroy or reuse the wrong child, so these stream a
      // document in chunks and require the result to match a from-scratch
      // render of the same final text.
      const shapeOf = (md: Markdown) => md.content.children.map((c) => c.constructor.name);

      function expectStreamMatchesRebuild(chunks: string[]): void {
        const streamed = new Markdown(chunks[0]);
        for (const chunk of chunks.slice(1)) streamed.appendMarkdown(chunk);
        const full = new Markdown(chunks.join(''));

        expect(shapeOf(streamed)).toEqual(shapeOf(full));
        expect((streamed as any).tokens.map((t: any) => t.raw)).toEqual(
          (full as any).tokens.map((t: any) => t.raw),
        );
        // The cached prefix sum must be exactly what a fresh render computed.
        expect((streamed as any).tokenChildPrefix).toEqual((full as any).tokenChildPrefix);
      }

      it('matches when blocks of mixed types are appended', () => {
        expectStreamMatchesRebuild([
          '# Title',
          '\n\nFirst paragraph.',
          '\n\n- a\n- b',
          '\n\n```js\nconst x = 1;\n```',
          '\n\n> quote',
          '\n\n---',
          '\n\nLast paragraph.',
        ]);
      });

      it('matches when the trailing paragraph grows across many chunks', () => {
        const chunks = ['# T\n\nStart'];
        for (let i = 0; i < 20; i++) chunks.push(` word${i}`);
        expectStreamMatchesRebuild(chunks);
      });

      it('matches when non-entity tokens (blank lines / html comments) are interleaved', () => {
        expectStreamMatchesRebuild([
          'Intro',
          '\n\n<!-- a comment -->',
          '\n\nAfter comment.',
          '\n\n<!-- another -->',
          '\n\nEnd.',
        ]);
      });

      it('keeps the prefix cache correct across a setContent reset', () => {
        const md = new Markdown('# One\n\nalpha');
        md.appendMarkdown('\n\nbeta');
        md.setContent('# Two\n\ngamma');
        md.appendMarkdown('\n\ndelta');

        const full = new Markdown('# Two\n\ngamma\n\ndelta');
        expect(shapeOf(md)).toEqual(shapeOf(full));
        expect((md as any).tokenChildPrefix).toEqual((full as any).tokenChildPrefix);
      });
    });
  });

  describe('destroy / child teardown (leak fix)', () => {
    it('destroy() tears down the whole content subtree', () => {
      const md = new Markdown('# Heading\n\nA paragraph with **bold**.\n\n- a\n- b');
      const blocks = [...md.content.children];
      expect(blocks.length).toBeGreaterThan(0);

      md.destroy();

      // Every block detached from content, and content detached from md.
      expect(md.content.children.length).toBe(0);
      for (const b of blocks) expect(b.parent).toBeNull();
    });

    it('setContent() destroys old blocks (not just detaches them)', () => {
      const md = new Markdown('First paragraph.');
      const oldBlock = md.content.children[0];
      const spy = vi.spyOn(oldBlock, 'destroy');

      md.setContent('Completely different.');

      expect(spy).toHaveBeenCalled();
      expect(oldBlock.parent).toBeNull();
      // New content rendered.
      expect(md.content.children.length).toBeGreaterThan(0);
      expect(md.content.children[0]).not.toBe(oldBlock);
    });

    it('appendMarkdown() (sync path) destroys blocks it discards on reconcile', () => {
      // jsdom has no Worker, so appendMarkdown reconciles synchronously.
      const md = new Markdown('para one\n\npara two');
      const before = [...md.content.children];
      expect(before.length).toBe(2);

      // Rewriting to a single block should discard (destroy) the extra block.
      md.setContent('just one block now');

      for (const b of before) expect(b.parent).toBeNull();
    });
  });

  describe('inline-math tokenizer does not eat currency', () => {
    // Inline math renders as a gold (#fcd34d) styled RichText span; currency
    // text does not. Collect every span so we can tell them apart.
    const MATH_COLOR = '#fcd34d';
    const collectSpansOf = (md: Markdown): Array<{ text: string; color?: string }> => {
      const out: Array<{ text: string; color?: string }> = [];
      const walk = (e: any) => {
        if (Array.isArray(e.spans)) {
          for (const s of e.spans) out.push({ text: s?.text ?? '', color: s?.style?.color });
        }
        if (typeof e.text === 'string' && !Array.isArray(e.spans)) out.push({ text: e.text });
        for (const c of e.children ?? []) walk(c);
      };
      walk(md.content);
      return out;
    };
    const hasMathSpan = (md: Markdown) => collectSpansOf(md).some((s) => s.color === MATH_COLOR);
    const allText = (md: Markdown) =>
      collectSpansOf(md)
        .map((s) => s.text)
        .join(' ');

    it('does not turn "$5 to $10" into a math span', () => {
      const md = new Markdown('It costs $5 to $10 per unit.');
      expect(hasMathSpan(md)).toBe(false); // no inline-math span produced
      const text = allText(md);
      expect(text).toContain('$5');
      expect(text).toContain('$10');
    });

    it('leaves standalone currency like "$9 each" as prose (no math span)', () => {
      const md = new Markdown('Only $9 each, down from $12.');
      expect(hasMathSpan(md)).toBe(false);
    });

    it('still tokenizes genuine inline math "$x+1$" as a math span', () => {
      const md = new Markdown('The equation $x+1$ holds.');
      expect(hasMathSpan(md)).toBe(true);
    });

    it('does not treat "$$" (empty) as a math span', () => {
      const md = new Markdown('An empty $$ pair.');
      expect(hasMathSpan(md)).toBe(false);
    });
  });

  describe('updateTokens child-index stays aligned across null-rendering tokens', () => {
    it('updates the right entity when a null-rendering HTML comment precedes the tail', () => {
      // An HTML comment renders no entity. A paragraph after it must still be
      // targeted correctly as the stream grows (previously the comment shifted
      // every subsequent child index by one).
      const md = new Markdown('<!-- note -->\n\nHello');
      const paras = md.content.children;
      const lastPara = paras[paras.length - 1];
      md.appendMarkdown(' world');
      // The same paragraph entity grew in place — not a sibling wrongly updated.
      expect(md.content.children[md.content.children.length - 1]).toBe(lastPara);
    });

    it('removes the correct block when a null-rendering token sits before the change', () => {
      const md = new Markdown('<!-- c -->\n\nkeep me\n\ndrop me');
      const keep = md.content.children.find((c: any) =>
        (c.spans?.[0]?.text ?? c.text ?? '').includes('keep'),
      );
      expect(keep).toBeDefined();
      // Rewrite so only "keep me" survives; the reconcile must not destroy the
      // wrong entity due to the leading comment's index offset.
      md.setContent('<!-- c -->\n\nkeep me');
      const survivors = md.content.children
        .map((c: any) => c.spans?.[0]?.text ?? c.text ?? '')
        .join(' ');
      expect(survivors).toContain('keep');
      expect(survivors).not.toContain('drop');
    });
  });
});
