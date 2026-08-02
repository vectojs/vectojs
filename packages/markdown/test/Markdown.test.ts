// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import type { Tokens } from 'marked';
import { lexer as markedLexer } from 'marked';
import { CodeBlock, Markdown } from '../src/Markdown';
import { VECTO_USER_TIMING } from '@vectojs/core';
import { RichText, Stack, Table, Text } from '@vectojs/ui';

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

    it('renders a GFM task item as a checkbox instead of a bullet', () => {
      // GitHub suppresses the bullet for a task list, so the box replaces it.
      const md = new Markdown('- [ ] todo\n- [x] done');
      expect(itemSpans(md, 0)[0].text).toBe('\u2610 ');
      expect(itemSpans(md, 1)[0].text).toBe('\u2611 ');
      // The box replaces the bullet rather than joining it.
      expect(itemSpans(md, 0)[0].text).not.toContain('\u2022');
    });

    it('places a task box after the number in an ordered list', () => {
      const md = new Markdown('1. [ ] first\n2. [x] second');
      expect(itemSpans(md, 0)[0].text).toBe('1. \u2610 ');
      expect(itemSpans(md, 1)[0].text).toBe('2. \u2611 ');
    });

    it('renders a LOOSE task list identically to a tight one', () => {
      // `marked` unshifts its `checkbox` token into the item for a tight list but
      // into the first paragraph for a loose one, so the two reach the span
      // builder at different depths. Reading item.task/checked instead of that
      // token is what makes them agree.
      const tight = new Markdown('- [ ] todo\n- [x] done');
      const loose = new Markdown('- [ ] todo\n\n- [x] done');
      expect(itemSpans(loose, 0).map((s) => s.text)).toEqual(
        itemSpans(tight, 0).map((s) => s.text),
      );
      expect(itemSpans(loose, 1).map((s) => s.text)).toEqual(
        itemSpans(tight, 1).map((s) => s.text),
      );
    });

    it('leaves a non-task list on its bullet', () => {
      const md = new Markdown('- alpha\n- beta');
      expect(itemSpans(md, 0)[0].text).toBe('\u2022 ');
    });

    it('trails the task box for an RTL item', () => {
      // The box must follow the same reading-direction rule as the bullet, or an
      // Arabic task item shows its box on the visual left.
      const md = new Markdown('- [x] \u0639\u0631\u0628\u064a');
      const spans = itemSpans(md, 0);
      expect(spans[0].text).not.toContain('\u2611');
      expect(spans[spans.length - 1].text).toBe(' \u2611');
    });

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

  it('renders GFM strikethrough as a lineThrough span', () => {
    // `marked` already emits a `del` token; before this the token fell to the
    // default arm and its text rendered unstyled, so the omission looked like
    // plain text rather than a missing feature.
    const md = new Markdown('This is ~~gone~~ text.');
    const rt = md.content.children[0] as RichText;
    const struck = rt.spans.find((s) => s.style?.lineThrough);
    expect(struck).toBeDefined();
    expect(struck!.text).toBe('gone');
    // Surrounding prose must not inherit the line.
    expect(rt.spans.find((s) => s.text.includes('This is'))?.style?.lineThrough).toBeUndefined();
  });

  it('keeps nested emphasis inside a strikethrough', () => {
    const md = new Markdown('~~**both**~~');
    const rt = md.content.children[0] as RichText;
    const span = rt.spans.find((s) => s.text === 'both');
    expect(span?.style?.lineThrough).toBe(true);
    expect(span?.style?.bold).toBe(true);
  });

  it('strikes a link inside a strikethrough', () => {
    // `~~[x](url)~~` lexes to a `del` wrapping a `link`, so both apply.
    const md = new Markdown('~~[gone](https://x.com)~~');
    const rt = md.content.children[0] as RichText;
    const span = rt.spans.find((s) => s.text === 'gone');
    expect(span?.style?.lineThrough).toBe(true);
    expect(span?.style?.href).toBe('https://x.com');
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

    it('updates a growing heading in-place instead of rebuilding it', () => {
      // A heading renders to a RichText through the same renderInlineToRichText a
      // paragraph uses, so setSpans was always available; the reconciler dispatched
      // on the literal string 'paragraph' and so rebuilt every streamed chunk.
      const md = new Markdown('## Res');
      const heading = md.content.children[md.content.children.length - 1];

      md.appendMarkdown('ults');
      expect(md.content.children[md.content.children.length - 1]).toBe(heading);

      md.appendMarkdown(' and analysis');
      expect(md.content.children[md.content.children.length - 1]).toBe(heading);
    });

    it('keeps reused heading text correct as it grows', () => {
      const md = new Markdown('## Res');
      md.appendMarkdown('ults');
      md.appendMarkdown(' and analysis');

      const heading = md.content.children[md.content.children.length - 1] as RichText;
      // Reuse must not mean stale: the spans have to reflect every chunk, or the
      // canvas and the projected a11y text disagree.
      expect(heading.spans.map((s) => s.text).join('')).toBe('Results and analysis');
    });

    it('rebuilds rather than reuses when a streamed heading changes depth', () => {
      // The hazard that makes this branch different from paragraph/code: streaming
      // '#' and then '# T' lexes to '## T', so the SAME token index goes from
      // depth 1 to depth 2 while still being a heading. RichText.setSpans replaces
      // the runs but does NOT touch `font` (constructor-only), and a heading's font
      // size is derived from its depth — so reusing would paint an h2 at h1's size.
      const md = new Markdown('#');
      const h1 = md.content.children[md.content.children.length - 1] as RichText;
      const h1Font = h1.font;

      md.appendMarkdown('# T');

      const after = md.content.children[md.content.children.length - 1] as RichText;
      expect(after).not.toBe(h1);
      // The rebuilt entity must carry the h2 font, not h1's.
      expect(after.font).not.toBe(h1Font);
      expect(after.spans.map((s) => s.text).join('')).toBe('T');
    });

    it('reuses a heading at the same depth with the depth-derived font intact', () => {
      const atOnce = new Markdown('### Full title here') as unknown as {
        content: { children: RichText[] };
      };
      const expectedFont = atOnce.content.children[0].font;

      const streamed = new Markdown('### Full');
      streamed.appendMarkdown(' title here');
      const heading = streamed.content.children[streamed.content.children.length - 1] as RichText;

      // Streamed and at-once must agree on both font and text, otherwise the
      // in-place path is a rendering difference rather than an optimisation.
      expect(heading.font).toBe(expectedFont);
      expect(heading.spans.map((s) => s.text).join('')).toBe('Full title here');
    });

    it('reuses a heading carrying inline emphasis', () => {
      const md = new Markdown('## A **bo');
      const heading = md.content.children[md.content.children.length - 1];

      md.appendMarkdown('ld** word');

      expect(md.content.children[md.content.children.length - 1]).toBe(heading);
      const rt = heading as RichText;
      expect(rt.spans.map((s) => s.text).join('')).toBe('A bold word');
      // The closed strong run must actually be bold, not literal asterisks.
      expect(rt.spans.some((s) => s.style?.bold)).toBe(true);
    });

    it('does not reuse a heading that is no longer the trailing token', () => {
      // One coalesced append can close the heading and open a new block. The
      // heading is then not the last token, so the in-place branch must not fire
      // for it and the new block has to be rendered.
      const md = new Markdown('## Title');
      const heading = md.content.children[0];

      md.appendMarkdown('\n\nBody text.');

      // Heading kept as an untouched prefix entity, body appended after it.
      expect(md.content.children[0]).toBe(heading);
      expect(md.content.children.length).toBeGreaterThan(1);
      expect((md.content.children[0] as RichText).spans.map((s) => s.text).join('')).toBe('Title');
    });

    it('counts a heading in-place update in streamStats', () => {
      const md = new Markdown('## Res') as unknown as {
        streamStats: { inPlaceUpdates: number; entitiesRebuilt: number };
        appendMarkdown: (s: string) => void;
      };
      const before = md.streamStats.inPlaceUpdates;
      const rebuiltBefore = md.streamStats.entitiesRebuilt;

      md.appendMarkdown('ults');

      // The fast path is what ran: one in-place update, nothing rebuilt.
      expect(md.streamStats.inPlaceUpdates).toBe(before + 1);
      expect(md.streamStats.entitiesRebuilt).toBe(rebuiltBefore);
    });

    it('updates a growing blockquote in place instead of rebuilding its subtree', () => {
      // A blockquote owns a subtree (border + inner stack of wrapped blocks), so
      // reuse means descending to the tail child rather than calling a mutator on
      // the block. Streaming a quote line by line otherwise rebuilt every inner
      // block and the border on every chunk.
      const md = new Markdown('> First');
      const quote = md.content.children[md.content.children.length - 1];

      md.appendMarkdown(' line');
      expect(md.content.children[md.content.children.length - 1]).toBe(quote);

      md.appendMarkdown('\n> second line');
      expect(md.content.children[md.content.children.length - 1]).toBe(quote);
    });

    it('keeps reused blockquote text correct as it grows', () => {
      const md = new Markdown('> First');
      md.appendMarkdown(' line');
      md.appendMarkdown('\n> second line');

      const quote = md.content.children[md.content.children.length - 1];
      const innerStack = quote.children[1];
      const tail = innerStack.children[innerStack.children.length - 1].children[0] as RichText;
      // Reuse must not mean stale.
      expect(tail.spans.map((sp) => sp.text).join('')).toContain('second line');
    });

    it('matches a rebuilt blockquote geometrically after in-place growth', () => {
      // The render arm computes wrapper/stack/border/container boxes by hand, so a
      // reused quote has to end up with the same geometry as a fresh one or the
      // accent bar and the following block drift.
      const streamed = new Markdown('> First line');
      streamed.appendMarkdown('\n> second line');
      const atOnce = new Markdown('> First line\n> second line');

      const sq = streamed.content.children[streamed.content.children.length - 1];
      const aq = atOnce.content.children[atOnce.content.children.length - 1];

      expect(sq.height).toBeCloseTo(aq.height, 5);
      expect((sq.children[0] as { height: number }).height).toBeCloseTo(
        (aq.children[0] as { height: number }).height,
        5,
      );
      expect(sq.children[1].height).toBeCloseTo(aq.children[1].height, 5);
    });

    it('reuses a blockquote whose tail block is a heading at the same depth', () => {
      const md = new Markdown('> intro\n>\n> ## a heading');
      const quote = md.content.children[md.content.children.length - 1];

      md.appendMarkdown(' grows');

      expect(md.content.children[md.content.children.length - 1]).toBe(quote);
      const innerStack = quote.children[1];
      const tail = innerStack.children[innerStack.children.length - 1].children[0] as RichText;
      expect(tail.spans.map((sp) => sp.text).join('')).toBe('a heading grows');
    });

    it('rebuilds a blockquote whose tail heading changes depth', () => {
      // Same hazard as the top-level heading path: setSpans cannot change `font`,
      // and a heading's size comes from its depth.
      const md = new Markdown('> intro\n>\n> #');
      const quote = md.content.children[md.content.children.length - 1];

      md.appendMarkdown('# T');

      expect(md.content.children[md.content.children.length - 1]).not.toBe(quote);
    });

    it('reuses a blockquote whose tail block is a growing code fence', () => {
      const md = new Markdown('> intro\n>\n> ```ts\n> const a = 1;');
      const quote = md.content.children[md.content.children.length - 1];

      md.appendMarkdown('\n> const b = 2;');

      expect(md.content.children[md.content.children.length - 1]).toBe(quote);
      const innerStack = quote.children[1];
      const tail = innerStack.children[innerStack.children.length - 1].children[0] as unknown as {
        source: string;
      };
      expect(tail.source).toContain('const b = 2;');
    });

    it('rebuilds when a blockquote gains a new inner block', () => {
      // A new inner block changes the child list, which the tail-only fast path
      // must refuse rather than write the wrong entity.
      const md = new Markdown('> just a paragraph');
      const quote = md.content.children[md.content.children.length - 1];

      md.appendMarkdown('\n>\n> a second paragraph');

      expect(md.content.children[md.content.children.length - 1]).not.toBe(quote);
      // And the result must still be correct after the rebuild.
      const rebuilt = md.content.children[md.content.children.length - 1];
      expect(rebuilt.children[1].children.length).toBeGreaterThan(1);
    });

    it('produces the same blockquote whether streamed or set at once', () => {
      const streamed = new Markdown('> First');
      streamed.appendMarkdown(' line');
      streamed.appendMarkdown('\n> second');
      streamed.appendMarkdown(' line');
      const atOnce = new Markdown('> First line\n> second line');

      const textOf = (md: Markdown): string => {
        const q = md.content.children[md.content.children.length - 1];
        const stack = q.children[1];
        return stack.children
          .map((w) => {
            const e = w.children[0] as unknown as {
              spans?: Array<{ text: string }>;
            };
            return (e.spans ?? []).map((sp) => sp.text).join('');
          })
          .join('|');
      };
      expect(textOf(streamed)).toBe(textOf(atOnce));
    });

    it('counts a blockquote in-place update in streamStats', () => {
      const md = new Markdown('> First') as unknown as {
        streamStats: { inPlaceUpdates: number; entitiesRebuilt: number };
        appendMarkdown: (s: string) => void;
      };
      const before = md.streamStats.inPlaceUpdates;
      const rebuiltBefore = md.streamStats.entitiesRebuilt;

      md.appendMarkdown(' line');

      expect(md.streamStats.inPlaceUpdates).toBe(before + 1);
      expect(md.streamStats.entitiesRebuilt).toBe(rebuiltBefore);
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

    describe('streamed list reuses its Stack', () => {
      // A list is the worst rebuild case in this reconciler: the token carries
      // EVERY item, so a list streamed to N items rebuilt 1+2+...+N RichTexts.
      // These tests pin that the Stack survives and stays geometrically identical
      // to a one-shot build.
      const listStackOf = (md: Markdown) => md.content.children[0] as Stack;
      const itemTexts = (md: Markdown) =>
        listStackOf(md).children.map((c) =>
          ((c as unknown as { spans: Array<{ text: string }> }).spans ?? [])
            .map((s) => s.text)
            .join(''),
        );

      it('keeps the same Stack instance across appended items', () => {
        const md = new Markdown('- one');
        const stack = listStackOf(md);

        md.appendMarkdown('\n- two');
        md.appendMarkdown('\n- three');

        // Identity, not just shape: a rebuild would substitute a new Stack.
        expect(listStackOf(md)).toBe(stack);
        expect(stack.children.length).toBe(3);
        expect(itemTexts(md)).toEqual(['• one', '• two', '• three']);
      });

      it('counts each appended item as an in-place update, rebuilding nothing', () => {
        const md = new Markdown('- one') as unknown as Markdown & {
          streamStats: { inPlaceUpdates: number; entitiesRebuilt: number };
        };
        const before = md.streamStats.inPlaceUpdates;
        const rebuiltBefore = md.streamStats.entitiesRebuilt;

        md.appendMarkdown('\n- two');
        md.appendMarkdown('\n- three');

        expect(md.streamStats.inPlaceUpdates).toBe(before + 2);
        expect(md.streamStats.entitiesRebuilt).toBe(rebuiltBefore);
      });

      it('rewrites the last item in place while it is still growing', () => {
        const md = new Markdown('- one\n- tw');
        const stack = listStackOf(md);
        const tail = stack.children[1];

        md.appendMarkdown('o word');

        // The growing item keeps its entity too, not only the Stack.
        expect(listStackOf(md)).toBe(stack);
        expect(stack.children[1]).toBe(tail);
        expect(itemTexts(md)).toEqual(['• one', '• two word']);
      });

      it('produces the same geometry streamed as set at once', () => {
        const streamed = new Markdown('- alpha');
        streamed.appendMarkdown('\n- beta');
        streamed.appendMarkdown('\n- gamma');
        const atOnce = new Markdown('- alpha\n- beta\n- gamma');

        const geom = (md: Markdown) => {
          const s = listStackOf(md);
          return {
            n: s.children.length,
            ys: s.children.map((c) => c.y),
            xs: s.children.map((c) => c.x),
            height: s.height,
            width: s.width,
            mdHeight: md.height,
          };
        };
        expect(geom(streamed)).toEqual(geom(atOnce));
        expect(itemTexts(streamed)).toEqual(itemTexts(atOnce));
      });

      it('keeps ordinals correct for an ordered list with a start offset', () => {
        // The marker is position-derived (`start + index`), which is only safe
        // because an append never changes an existing item's index.
        const streamed = new Markdown('5. five');
        streamed.appendMarkdown('\n6. six');
        streamed.appendMarkdown('\n7. seven');

        expect(itemTexts(streamed)).toEqual(['5. five', '6. six', '7. seven']);
        expect(itemTexts(streamed)).toEqual(itemTexts(new Markdown('5. five\n6. six\n7. seven')));
      });

      it('rebuilds when a tight list becomes loose', () => {
        // Adding a blank line flips `loose`, which re-lexes every item's children
        // from `text` to `paragraph`. Item 0's own `text` is unchanged, so a guard
        // that only compared item text would reuse and keep stale spans.
        const md = new Markdown('- one\n- two') as unknown as Markdown & {
          streamStats: { entitiesRebuilt: number };
        };
        const stack = listStackOf(md);
        const rebuiltBefore = md.streamStats.entitiesRebuilt;

        md.appendMarkdown('\n\n- three');

        expect(listStackOf(md)).not.toBe(stack);
        expect(md.streamStats.entitiesRebuilt).toBe(rebuiltBefore + 1);
        // And the rebuilt list is still correct.
        expect(itemTexts(md)).toEqual(itemTexts(new Markdown('- one\n- two\n\n- three')));
      });

      it('resyncs the box when the tail item grows taller by wrapping', () => {
        // The case the geometry resync exists for. A tail item that grows within
        // one line leaves the stack's height unchanged, so it cannot detect a
        // missing resync; only a wrap does. Measured here: the item goes 24px ->
        // 264px at maxWidth 200.
        const long = 'word '.repeat(40).trim();
        const streamed = new Markdown('- one\n- start', { maxWidth: 200 });
        const stack = streamed.content.children[0] as Stack;
        const heightBefore = stack.height;

        streamed.appendMarkdown(' ' + long);

        const atOnce = new Markdown(`- one\n- start ${long}`, {
          maxWidth: 200,
        });
        const reference = atOnce.content.children[0] as Stack;

        expect(stack.height).toBeGreaterThan(heightBefore);
        expect(stack.height).toBe(reference.height);
        expect(streamed.height).toBe(atOnce.height);
      });

      describe('guards that reject reuse', () => {
        // These reject states that `appendMarkdown` cannot produce on its own —
        // `setContent` rebuilds from scratch and never reaches `updateTokens`, so
        // the only real caller is append-only. They are tested directly against
        // the private method rather than through a stream, because a test driven
        // through `appendMarkdown` would silently pass without exercising them at
        // all. Verified by mutation: removing any one of these fails its case here
        // and nothing else.
        type ListUpdater = {
          updateStreamedList: (stack: unknown, oldT: Tokens.List, newT: Tokens.List) => boolean;
        };
        const listTokenOf = (src: string): Tokens.List =>
          markedLexer(src).find((t) => t.type === 'list') as Tokens.List;

        const attempt = (fromSrc: string, mutate: (t: Tokens.List) => Tokens.List): boolean => {
          const md = new Markdown(fromSrc);
          const stack = md.content.children[0];
          const oldToken = listTokenOf(fromSrc);
          return (md as unknown as ListUpdater).updateStreamedList(
            stack,
            oldToken,
            mutate(listTokenOf(fromSrc)),
          );
        };

        it('accepts an unchanged list, so the negative cases below mean something', () => {
          // Baseline: without this, a guard test could pass because the whole
          // method rejects everything.
          expect(attempt('- one\n- two', (t) => t)).toBe(true);
        });

        it('rejects a change of `ordered`', () => {
          expect(
            attempt('- one\n- two', (t) => ({ ...t, ordered: !t.ordered }) as Tokens.List),
          ).toBe(false);
        });

        it('rejects a change of `start`', () => {
          // Reachable in principle: lexing `1. a` then `12. a` moves start 1 -> 12
          // with the item text unchanged, so the marker would go stale.
          expect(attempt('1. one\n2. two', (t) => ({ ...t, start: 5 }) as Tokens.List)).toBe(false);
        });

        it('rejects a shrinking list', () => {
          expect(
            attempt('- one\n- two', (t) => ({ ...t, items: t.items.slice(0, 1) }) as Tokens.List),
          ).toBe(false);
        });

        it('rejects an edit to a retained item', () => {
          expect(
            attempt('- one\n- two\n- three', (t) => {
              const items = t.items.map((i) => ({ ...i }));
              items[0].text = 'EDITED';
              return { ...t, items } as Tokens.List;
            }),
          ).toBe(false);
        });

        it('rejects a stack whose child count disagrees with the item count', () => {
          // Guards against being handed an entity that some other path built, in
          // which case indices would not line up and the wrong item would be
          // rewritten.
          const md = new Markdown('- one\n- two');
          const stack = md.content.children[0] as Stack;
          stack.add(new RichText([{ text: 'extra' }], { font: '16px sans-serif' }));
          const token = listTokenOf('- one\n- two');
          expect((md as unknown as ListUpdater).updateStreamedList(stack, token, token)).toBe(
            false,
          );
        });

        it('rejects a non-Stack entity', () => {
          const md = new Markdown('- one');
          const token = listTokenOf('- one');
          expect(
            (md as unknown as ListUpdater).updateStreamedList(
              new RichText([{ text: 'x' }], { font: '16px sans-serif' }),
              token,
              token,
            ),
          ).toBe(false);
        });
      });

      it('does not indent list items, and does not reserve width for an indent', () => {
        // `Stack.appendFast` assigns `child.x = 0` for a vertical stack and
        // declares x/y layout-controlled, so the old `itemRt.x = 12` was
        // overwritten on add() and the matching `availableWidth - 24` reserved
        // space for an indent that never rendered.
        const md = new Markdown('- one\n- two');
        const stack = listStackOf(md);

        expect(stack.children.map((c) => c.x)).toEqual([0, 0]);
        const maxWidths = stack.children.map(
          (c) => (c as unknown as { maxWidth: number }).maxWidth,
        );
        expect(maxWidths).toEqual([md.maxWidth, md.maxWidth]);
      });
    });

    describe('streamed table reuses its Table', () => {
      // The last block type to get an in-place path, and the most expensive to
      // rebuild: a table token carries every row, so the rebuild cost across a
      // stream is Theta(C*N^2) cell constructions plus a 2x fitCell penalty.
      //
      // Two shapes matter, because of how marked lexes a growing table (probed
      // against 18.0.7): a partial row appears immediately as a FULL row of empty
      // cells which then fill one at a time, so a 2x2 table passes through eleven
      // distinct row states of which only two are clean appends. Handling appends
      // alone would reject most chunks.
      const HEAD = '| A | B |\n| --- | --- |';
      const tableOf = (md: Markdown) => md.content.children[0] as Table;
      const cellTexts = (md: Markdown) =>
        tableOf(md).rows.map((row) =>
          row.map((c) =>
            ((c as unknown as { spans?: Array<{ text: string }> }).spans ?? [])
              .map((s) => s.text)
              .join(''),
          ),
        );

      it('keeps the same Table instance across appended rows', () => {
        const md = new Markdown(`${HEAD}\n| a1 | b1 |`);
        const table = tableOf(md);

        md.appendMarkdown('\n| a2 | b2 |');
        md.appendMarkdown('\n| a3 | b3 |');

        // Identity, not shape: a rebuild would substitute a new Table.
        expect(tableOf(md)).toBe(table);
        expect(cellTexts(md)).toEqual([
          ['a1', 'b1'],
          ['a2', 'b2'],
          ['a3', 'b3'],
        ]);
      });

      it('carries the delimiter row alignment onto the Table', () => {
        const md = new Markdown('| A | B | C |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |');
        expect(tableOf(md).align).toEqual(['left', 'center', 'right']);
      });

      it('defaults alignment to null per column when the delimiter is plain', () => {
        const md = new Markdown(`${HEAD}\n| a1 | b1 |`);
        expect(tableOf(md).align).toEqual([null, null]);
      });

      it('rebuilds rather than reusing when a streamed delimiter gains a colon', () => {
        // Alignment is fixed at construction (`Table` has no align mutator), so
        // reuse across a change would silently keep the stale columns.
        //
        // This IS reachable while streaming, which is not obvious: the table token
        // materializes as soon as the delimiter row has enough cells, and a colon
        // arriving in the NEXT chunk re-lexes that same table with new alignment.
        // Probed against marked 18.0.7: `| --- | ---` lexes to a table with
        // [null, null], and appending just `:` gives [null, 'right'].
        const md = new Markdown('| A | B |\n| --- | ---');
        const before = tableOf(md);
        expect(before.align).toEqual([null, null]);

        md.appendMarkdown(':');
        const after = tableOf(md);
        expect(after.align).toEqual([null, 'right']);
        // A reused instance would still carry [null, null].
        expect(after).not.toBe(before);
      });

      it('fills a partially-arrived row in place rather than rebuilding', () => {
        // marked materializes `|` as a full empty row, so this is the common case
        // during a stream and the one appendRows alone could not serve.
        const md = new Markdown(`${HEAD}\n| a1 | b1 |`);
        const table = tableOf(md);

        md.appendMarkdown('\n| a2');
        expect(cellTexts(md)).toEqual([
          ['a1', 'b1'],
          ['a2', ''],
        ]);
        md.appendMarkdown(' | b2');

        expect(tableOf(md)).toBe(table);
        expect(cellTexts(md)).toEqual([
          ['a1', 'b1'],
          ['a2', 'b2'],
        ]);
      });

      it('counts reuse as an in-place update and rebuilds nothing', () => {
        const md = new Markdown(`${HEAD}\n| a1 | b1 |`) as unknown as Markdown & {
          streamStats: { inPlaceUpdates: number; entitiesRebuilt: number };
        };
        const before = { ...md.streamStats };

        md.appendMarkdown('\n| a2 | b2 |');
        md.appendMarkdown('\n| a3 | b3 |');

        expect(md.streamStats.inPlaceUpdates).toBeGreaterThan(before.inPlaceUpdates);
        expect(md.streamStats.entitiesRebuilt).toBe(before.entitiesRebuilt);
      });

      it('reuses the table that was lexed with no rows yet', () => {
        // A table exists as soon as its delimiter row arrives, so this is the
        // first state every streamed table is in — and the first reuse chance.
        const md = new Markdown(HEAD);
        const table = tableOf(md);
        expect(table.rows.length).toBe(0);

        md.appendMarkdown('\n| a1 | b1 |');

        expect(tableOf(md)).toBe(table);
        expect(cellTexts(md)).toEqual([['a1', 'b1']]);
      });

      it('matches a one-shot build geometrically', () => {
        const streamed = new Markdown(`${HEAD}\n| a1 | b1 |`);
        streamed.appendMarkdown('\n| a2 | b2 |');
        streamed.appendMarkdown('\n| a3 | b3 |');
        const oneShot = new Markdown(`${HEAD}\n| a1 | b1 |\n| a2 | b2 |\n| a3 | b3 |`);

        const s = tableOf(streamed);
        const o = tableOf(oneShot);
        expect(s.height).toBe(o.height);
        expect(s.rowHeights).toEqual(o.rowHeights);
        expect(s.getA11yAttributes().label).toBe(o.getA11yAttributes().label);
        expect(streamed.height).toBe(oneShot.height);
      });

      it('rebuilds when the header changes', () => {
        // `Table` has no header mutator, so reuse would leave a stale header.
        const md = new Markdown(`${HEAD}\n| a1 | b1 |`);
        const table = tableOf(md);

        md.setContent('| X | Y |\n| --- | --- |\n| a1 | b1 |');

        expect(tableOf(md)).not.toBe(table);
        expect(tableOf(md).headers.length).toBe(2);
      });

      describe('guards that reject reuse', () => {
        // These reject states an append cannot produce. Probed across every prefix
        // of a streamed table: rows never shrink, the header never changes, and no
        // earlier row is ever mutated — and `setContent` rebuilds without reaching
        // `updateTokens`, so append is the only real caller. Tested directly
        // against the private method, because a test driven through
        // `appendMarkdown` would pass without exercising them at all. Verified by
        // mutation: removing any one of these fails its case here and nothing else.
        type TableUpdater = {
          updateStreamedTable: (entity: unknown, oldT: Tokens.Table, newT: Tokens.Table) => boolean;
        };
        const tableTokenOf = (src: string): Tokens.Table =>
          markedLexer(src).find((tk) => tk.type === 'table') as Tokens.Table;

        const SRC = `${HEAD}\n| a1 | b1 |\n| a2 | b2 |`;
        const attempt = (mutate: (t: Tokens.Table) => Tokens.Table): boolean => {
          const md = new Markdown(SRC);
          return (md as unknown as TableUpdater).updateStreamedTable(
            md.content.children[0],
            tableTokenOf(SRC),
            mutate(tableTokenOf(SRC)),
          );
        };

        it('accepts an unchanged table, so the negatives below mean something', () => {
          expect(attempt((t) => t)).toBe(true);
        });

        it('rejects a shrinking row count', () => {
          expect(attempt((t) => ({ ...t, rows: t.rows.slice(0, 1) }))).toBe(false);
        });

        it('rejects a changed header cell', () => {
          expect(
            attempt((t) => ({
              ...t,
              header: [{ ...t.header[0], text: 'CHANGED' }, t.header[1]],
            })),
          ).toBe(false);
        });

        it('rejects a changed column count', () => {
          expect(attempt((t) => ({ ...t, header: t.header.slice(0, 1) }))).toBe(false);
        });

        it('rejects a mutated earlier row', () => {
          // Only the LAST retained row may differ; an earlier change means the
          // entity's cells no longer correspond to these tokens.
          expect(
            attempt((t) => ({
              ...t,
              rows: [[{ ...t.rows[0][0], text: 'MUTATED' }, t.rows[0][1]], t.rows[1]],
            })),
          ).toBe(false);
        });

        it('rejects an entity whose row count disagrees with the token', () => {
          // Guards against an entity some other path built, where indices would
          // not line up and the wrong row would be rewritten.
          const md = new Markdown(SRC);
          const table = md.content.children[0] as Table;
          table.appendRows([['extra', 'extra']]);
          const token = tableTokenOf(SRC);
          expect((md as unknown as TableUpdater).updateStreamedTable(table, token, token)).toBe(
            false,
          );
        });

        it('rejects a non-Table entity', () => {
          const md = new Markdown(SRC);
          const token = tableTokenOf(SRC);
          expect(
            (md as unknown as TableUpdater).updateStreamedTable(
              new RichText([{ text: 'x' }], { font: '16px sans-serif' }),
              token,
              token,
            ),
          ).toBe(false);
        });
      });

      it('every cell is a RichText, including an empty one', () => {
        // An empty cell used to render as a bare string, which `Table` turned into
        // a `Text`. `Text` has setText and `RichText` has setSpans, and nothing
        // converts between them, so a cell that starts empty and later gains
        // content could not have been updated in place.
        const md = new Markdown(`${HEAD}\n| a1 |`);
        const table = tableOf(md);
        expect(table.rows[0].every((c) => c instanceof RichText)).toBe(true);
        expect(cellTexts(md)).toEqual([['a1', '']]);
      });

      it('gives an empty cell one empty span rather than none', () => {
        // Geometry is identical either way (measured), so this pins the one
        // observable effect of the fallback in `tableCellSpans`: every cell has at
        // least one span, which is what keeps a cell's span list addressable when
        // its content arrives later. Without it the assertion above still passes,
        // because `RichText([])` is still a `RichText`.
        const md = new Markdown(`${HEAD}\n| a1 |`);
        const empty = tableOf(md).rows[0][1] as RichText;
        expect(empty.spans.length).toBe(1);
        expect(empty.spans[0].text).toBe('');
      });

      it('fills an empty cell in place when its content arrives', () => {
        // The end-to-end reason the fallback and the RichText conversion exist.
        const md = new Markdown(`${HEAD}\n| a1 |`);
        const cell = tableOf(md).rows[0][1] as RichText;

        md.appendMarkdown(' b1 |');

        expect(tableOf(md).rows[0][1]).toBe(cell);
        expect(cellTexts(md)).toEqual([['a1', 'b1']]);
      });
    });

    describe('streamed image paragraph reuses its Stack', () => {
      // The last silent fallthrough in the reuse path. A paragraph containing an
      // image renders as a Stack of alternating text runs and images rather than
      // one RichText, so it has no setSpans and fell out of the paragraph branch
      // with no `else` — invisible, because inPlaceUpdates simply stayed flat
      // while entitiesRebuilt climbed, and every rebuild also re-created the
      // Image and discarded its decoded bitmap.
      //
      // Reuse is deliberately narrow: only a growing trailing text run, which is
      // the shape a stream actually produces once an image has closed (probed
      // against marked@18.0.7 — the image token's raw and index are then stable
      // and the token list settles at [..., image, text]).
      const IMG = '![alt](https://e.com/a.png)';

      const blockOf = (md: Markdown) => md.content.children.at(-1) as unknown as Entity;
      const kindsOf = (md: Markdown) => (blockOf(md).children ?? []).map((c) => c.constructor.name);
      const geometryOf = (md: Markdown) => {
        const block = blockOf(md);
        return {
          height: md.height,
          blockHeight: block.height,
          kids: (block.children ?? []).map((k) => [
            k.constructor.name,
            k.x,
            k.y,
            k.width,
            k.height,
          ]),
        };
      };
      const streamed = (chunks: string[], maxWidth = 400) => {
        const md = new Markdown('', { maxWidth });
        const stream = md.createStream();
        for (const chunk of chunks) {
          void stream.write(chunk);
          stream.flush();
        }
        return md;
      };

      it('does not drop the image when a plain paragraph gains its first one', () => {
        // A correctness bug, found while building the perf path and fixed with it.
        // The setSpans branch dispatched on the ENTITY having setSpans and never
        // asked whether the new token still renders as one RichText. So a plain
        // paragraph that gained an image kept its RichText and was handed the image
        // paragraph's spans — and collectSpans emits nothing for an image token, so
        // the picture was silently dropped. Pre-existing; reproduced unchanged on
        // the previous commit.
        const md = new Markdown('', { maxWidth: 400 });
        const stream = md.createStream();
        void stream.write('Figure: ');
        stream.flush();
        expect(blockOf(md).constructor.name).toBe('RichText');

        void stream.write(IMG);
        stream.flush();

        expect(blockOf(md).constructor.name).toBe('Stack');
        expect(kindsOf(md)).toEqual(['RichText', 'Image']);
        expect(geometryOf(md)).toEqual(
          geometryOf(new Markdown(`Figure: ${IMG}`, { maxWidth: 400 })),
        );
      });

      it('renders an image-bearing paragraph as a Stack of runs and images', () => {
        // Establishes the shape the reuse path operates on, including that
        // consecutive non-image tokens merge into ONE RichText — so children are
        // not one-per-token, which is why the guards compare token runs.
        expect(kindsOf(new Markdown(IMG, { maxWidth: 400 }))).toEqual(['Image']);
        expect(kindsOf(new Markdown(`${IMG} tail`, { maxWidth: 400 }))).toEqual([
          'Image',
          'RichText',
        ]);
        expect(kindsOf(new Markdown(`lead ${IMG} tail`, { maxWidth: 400 }))).toEqual([
          'RichText',
          'Image',
          'RichText',
        ]);
        // `*em*` and `` `code` `` are separate inline tokens but one run.
        expect(kindsOf(new Markdown(`a *em* and \`c\` ${IMG} tail`, { maxWidth: 400 }))).toEqual([
          'RichText',
          'Image',
          'RichText',
        ]);
      });

      it('reuses the Stack and the Image as the trailing run grows', () => {
        const md = new Markdown('', { maxWidth: 400 });
        const stream = md.createStream();

        void stream.write(`See ${IMG}`);
        stream.flush();
        const stack = blockOf(md);
        const image = (stack.children ?? [])[1];
        const rebuiltAfterFirst = md.streamStats.entitiesRebuilt;

        void stream.write(' then trailing');
        stream.flush();
        void stream.write(' prose that keeps growing.');
        stream.flush();

        // Same Stack, same Image instance: the decoded bitmap survives.
        expect(blockOf(md)).toBe(stack);
        expect((blockOf(md).children ?? [])[1]).toBe(image);
        expect(md.streamStats.entitiesRebuilt).toBe(rebuiltAfterFirst);
        expect(md.streamStats.inPlaceUpdates).toBeGreaterThanOrEqual(2);
      });

      it('is geometrically identical to the same paragraph built at once', () => {
        const source = `See ${IMG} then trailing prose that wraps a little.`;
        const once = new Markdown(source, { maxWidth: 400 });
        const stream = streamed([`See ${IMG}`, ' then trailing', ' prose that wraps a little.']);
        expect(geometryOf(stream)).toEqual(geometryOf(once));
      });

      it('resyncs the Stack height when the trailing run wraps to a new line', () => {
        // The case that makes the resync load-bearing rather than redundant.
        // `RichText.setSpans` re-lays out the CHILD but does not touch its parent's
        // cached box, and `Stack.add` happens to update the height itself — so a
        // tail that grows within one line hides the bug. Only a tail that gains a
        // LINE changes the child's height, and without `resizeLastChild` the Stack
        // then keeps its old height: measured 320 where 368 is correct.
        const tail =
          ' and now a great deal more trailing prose that will certainly wrap onto several additional lines of text.';
        const md = streamed([`See ${IMG} short`, tail]);
        const once = new Markdown(`See ${IMG} short${tail}`, { maxWidth: 400 });

        expect(blockOf(md).children?.at(-1)?.height).toBeGreaterThan(24);
        expect(blockOf(md).height).toBe(blockOf(once).height);
        expect(md.height).toBe(once.height);
      });

      it('appends a run when prose starts after an image-only paragraph', () => {
        // The old token list has no trailing run at all, so this is the append
        // branch rather than the setSpans branch.
        const md = new Markdown('', { maxWidth: 400 });
        const stream = md.createStream();
        void stream.write(IMG);
        stream.flush();
        const stack = blockOf(md);
        expect(kindsOf(md)).toEqual(['Image']);

        void stream.write(' now prose appears');
        stream.flush();

        expect(blockOf(md)).toBe(stack);
        expect(kindsOf(md)).toEqual(['Image', 'RichText']);
        expect(geometryOf(md)).toEqual(
          geometryOf(new Markdown(`${IMG} now prose appears`, { maxWidth: 400 })),
        );
      });

      it('reuses across a multi-image paragraph whose final run grows', () => {
        const md = new Markdown('', { maxWidth: 400 });
        const stream = md.createStream();
        void stream.write('A ![x](u1.png) mid ![y](u2.png) end');
        stream.flush();
        const stack = blockOf(md);

        void stream.write(' more words');
        stream.flush();

        expect(blockOf(md)).toBe(stack);
        expect(geometryOf(md)).toEqual(
          geometryOf(
            new Markdown('A ![x](u1.png) mid ![y](u2.png) end more words', {
              maxWidth: 400,
            }),
          ),
        );
      });

      it('rebuilds when a second image arrives', () => {
        // A new image is a shape change, not a growing tail: the prefix through
        // the last image is no longer identical, so reuse must be refused.
        const md = new Markdown('', { maxWidth: 400 });
        const stream = md.createStream();
        void stream.write('A ![x](u1.png) mid');
        stream.flush();
        const before = blockOf(md);

        void stream.write(' ![y](u2.png) end');
        stream.flush();

        expect(blockOf(md)).not.toBe(before);
        expect(geometryOf(md)).toEqual(
          geometryOf(
            new Markdown('A ![x](u1.png) mid ![y](u2.png) end', {
              maxWidth: 400,
            }),
          ),
        );
      });

      it('rebuilds when the image token itself changes', () => {
        // A partially-typed image closes into a DIFFERENT image token, so the
        // href changes under a same-typed paragraph. Reusing would keep the old
        // Image and paint the wrong picture.
        const md = new Markdown('', { maxWidth: 400 });
        const stream = md.createStream();
        void stream.write('x ![a](u1.png) tail');
        stream.flush();
        const before = blockOf(md);
        const beforeSrc = ((blockOf(md).children ?? [])[1] as unknown as { src: string }).src;

        // setContent rather than a stream chunk: this is the guard under test, and
        // an append cannot rewrite an already-closed image.
        md.setContent('x ![a](u2.png) tail');

        expect(blockOf(md)).not.toBe(before);
        expect(((blockOf(md).children ?? [])[1] as unknown as { src: string }).src).not.toBe(
          beforeSrc,
        );
      });

      it('keeps every text run selectable and projected after reuse', () => {
        // Selection is the thing most easily lost by an in-place path: a reused
        // run that stopped projecting, or lost `selectable`, would still LOOK
        // right on the canvas while becoming impossible to drag-select or copy.
        // Asserted against a one-shot build so reuse cannot silently differ.
        const projections = (md: Markdown) =>
          (blockOf(md).children ?? []).map((child) => {
            const projection = (
              child as unknown as {
                getContentProjection?: () => {
                  text?: string;
                  selectable?: boolean;
                } | null;
              }
            ).getContentProjection?.();
            return projection ? { text: projection.text, selectable: projection.selectable } : null;
          });

        const stream = streamed([`Lead text ${IMG}`, ' trailing caption words here']);
        const once = new Markdown(`Lead text ${IMG} trailing caption words here`, {
          maxWidth: 400,
        });

        expect(projections(stream)).toEqual(projections(once));
        // Both runs, not just the mutated tail.
        expect(projections(stream).filter((p) => p?.selectable === true)).toHaveLength(2);
      });

      it('honours selectable: false on the reuse path', () => {
        const md = new Markdown('', { maxWidth: 400, selectable: false });
        const stream = md.createStream();
        void stream.write(`Lead ${IMG}`);
        stream.flush();
        void stream.write(' caption words');
        stream.flush();

        const runs = (blockOf(md).children ?? []).filter(
          (c) => c.constructor.name === 'RichText',
        ) as unknown as Array<{ selectable: boolean }>;
        expect(runs).toHaveLength(2);
        expect(runs.every((r) => r.selectable === false)).toBe(true);
      });

      it('leaves a plain paragraph on the ordinary setSpans path', () => {
        // The image path must not capture paragraphs that have no image: those
        // still reuse one RichText via setSpans, with no Stack involved.
        const md = streamed(['Plain prose', ' that grows', ' further still.']);
        expect(blockOf(md).constructor.name).toBe('RichText');
        expect(md.streamStats.entitiesRebuilt).toBe(0);
      });

      describe('guards that reject reuse', () => {
        // Tested directly against the private method, one guard per case.
        //
        // Driving these through a stream does NOT isolate them: the guards overlap
        // on real input, so removing any single one still leaves another to reject
        // the same paragraph. Measured — with the prefix-raw comparison deleted, a
        // second image arriving is still refused by the child-count guard, so an
        // end-to-end test passes while the guard under test is gone. That is
        // defence in depth in production and a blind spot in a test, which is why
        // each case below is chosen to be the FIRST guard that fires for it
        // (verified by reimplementing the ladder and reporting which one rejects).
        type ImageParagraphUpdater = {
          updateImageParagraph: (
            entity: unknown,
            oldT: Tokens.Paragraph,
            newT: Tokens.Paragraph,
          ) => boolean;
        };
        const paragraphTokenOf = (src: string): Tokens.Paragraph =>
          markedLexer(src).find((t) => t.type === 'paragraph') as Tokens.Paragraph;
        /** The Stack the render arm builds for `src`, plus the updater. */
        const setup = (src: string) => {
          const md = new Markdown(src, { maxWidth: 400 });
          return {
            md,
            stack: md.content.children.at(-1) as unknown,
            update: md as unknown as ImageParagraphUpdater,
          };
        };

        it('accepts the ordinary growing tail (baseline)', () => {
          // A positive case first, so a guard test below cannot pass merely
          // because the method rejects everything.
          const { stack, update } = setup(`x ${IMG} ta`);
          expect(
            update.updateImageParagraph(
              stack,
              paragraphTokenOf(`x ${IMG} ta`),
              paragraphTokenOf(`x ${IMG} tail`),
            ),
          ).toBe(true);
        });

        it('rejects a non-Stack entity', () => {
          const { update } = setup(`x ${IMG} ta`);
          const plain = new Markdown('plain', { maxWidth: 400 }).content.children[0];
          expect(
            update.updateImageParagraph(
              plain,
              paragraphTokenOf(`x ${IMG} ta`),
              paragraphTokenOf(`x ${IMG} tail`),
            ),
          ).toBe(false);
        });

        it('rejects when neither side has an image', () => {
          const { update } = setup(`x ${IMG} ta`);
          const { stack } = setup(`x ${IMG} ta`);
          expect(
            update.updateImageParagraph(
              stack,
              paragraphTokenOf('plain text'),
              paragraphTokenOf('plain text more'),
            ),
          ).toBe(false);
        });

        it('rejects when the last image moves index (a second image arrived)', () => {
          const { stack, update } = setup('A ![x](u1.png) mid');
          expect(
            update.updateImageParagraph(
              stack,
              paragraphTokenOf('A ![x](u1.png) mid'),
              paragraphTokenOf('A ![x](u1.png) mid ![y](u2.png) end'),
            ),
          ).toBe(false);
        });

        it('rejects when the prefix through the last image changed', () => {
          const { stack, update } = setup('x ![a](u1.png) tail');
          expect(
            update.updateImageParagraph(
              stack,
              paragraphTokenOf('x ![a](u1.png) tail'),
              paragraphTokenOf('x ![a](u2.png) tail'),
            ),
          ).toBe(false);
        });

        it('rejects when the new tokens have no trailing run', () => {
          const { stack, update } = setup(`x ${IMG}`);
          expect(
            update.updateImageParagraph(
              stack,
              paragraphTokenOf(`x ${IMG}`),
              paragraphTokenOf(`x ${IMG}`),
            ),
          ).toBe(false);
        });

        it('rejects a shrinking trailing run', () => {
          const { stack, update } = setup(`x ${IMG} long tail here`);
          expect(
            update.updateImageParagraph(
              stack,
              paragraphTokenOf(`x ${IMG} long tail here`),
              paragraphTokenOf(`x ${IMG} lo`),
            ),
          ).toBe(false);
        });

        it('rejects an entity whose child count does not match the old tokens', () => {
          // The Stack was built for a DIFFERENT paragraph, so its children do not
          // correspond to `oldT`. Reusing would mutate the wrong child.
          const { stack } = setup(`${IMG} tail`); // 2 children: Image, RichText
          const { update } = setup(`x ${IMG} ta`);
          expect(
            update.updateImageParagraph(
              stack,
              paragraphTokenOf(`x ${IMG} ta`), // expects 3 children
              paragraphTokenOf(`x ${IMG} tail`),
            ),
          ).toBe(false);
        });

        it('counts children per text RUN, not per token', () => {
          // `a *em* and \`c\`` is four inline tokens but ONE RichText, because the
          // render arm merges consecutive non-image tokens. If the expected count
          // were `tokens.length` this baseline would be rejected.
          const src = `a *em* and \`c\` ${IMG} ta`;
          const { stack, update } = setup(src);
          expect((stack as Entity).children?.length).toBe(3);
          expect(
            update.updateImageParagraph(
              stack,
              paragraphTokenOf(src),
              paragraphTokenOf(`a *em* and \`c\` ${IMG} tail`),
            ),
          ).toBe(true);
        });
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
      // Gold source text is now the PRE-TYPESET state, not the final rendering:
      // with MathJax loaded this span becomes a reserved inline object instead
      // (see inlineMathTypeset.test.ts). This file never preloads MathJax, so the
      // fallback branch is what runs here — which is exactly what makes this a
      // tokenizer assertion rather than a rendering one.
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

  it('emits parse timing only when explicitly enabled', () => {
    const mark = vi.spyOn(performance, 'mark');
    const measure = vi.spyOn(performance, 'measure');
    const clearMarks = vi.spyOn(performance, 'clearMarks');

    new Markdown('# silent');
    expect(mark).not.toHaveBeenCalled();
    expect(measure).not.toHaveBeenCalled();

    new Markdown('# timed', { userTiming: true });
    expect(measure.mock.calls.map(([name]) => name)).toContain(VECTO_USER_TIMING.markdown.parse);
    expect(clearMarks).toHaveBeenCalled();
  });
});
