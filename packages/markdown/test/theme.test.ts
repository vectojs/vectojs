// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { RichText, Stack } from '@vectojs/ui';
import { CodeBlock, Markdown } from '../src/Markdown';

/**
 * The exact 12-key theme literal that existed before the token centralization
 * of 2026-08-06. Frozen here on purpose: `CodeBlock` and `Markdown` are public
 * API, so a caller written against this shape must keep working after new keys
 * are added. Do not extend it — that is the whole point of the fixture.
 */
const LEGACY_THEME = {
  textColor: '#e2e8f0',
  headingColor: '#f8fafc',
  codeColor: '#a5f3fc',
  codeBgColor: 'rgba(30, 41, 59, 0.85)',
  quoteBorderColor: '#6366f1',
  quoteTextColor: '#94a3b8',
  hrColor: 'rgba(148, 163, 184, 0.3)',
  tableBgColor: 'rgba(15, 15, 25, 0.4)',
  tableHeaderBgColor: 'rgba(255, 255, 255, 0.08)',
  bodyFont: 'Inter, system-ui, sans-serif',
  codeFont: 'ui-monospace, "JetBrains Mono", "Fira Code", monospace',
  fontSize: 16,
};

/** First `RichText` found in a depth-first walk, or `null`. */
function findRichText(entity: { children: readonly unknown[] }): RichText | null {
  for (const child of entity.children) {
    if (child instanceof RichText) return child;
    const nested = findRichText(child as { children: readonly unknown[] });
    if (nested) return nested;
  }
  return null;
}

/** Every `RichText` in the tree, in document order. */
function allRichText(entity: { children: readonly unknown[] }): RichText[] {
  const out: RichText[] = [];
  for (const child of entity.children) {
    if (child instanceof RichText) out.push(child);
    out.push(...allRichText(child as { children: readonly unknown[] }));
  }
  return out;
}

describe('Markdown theme tokens', () => {
  describe('backward compatibility', () => {
    it('accepts the legacy 12-key theme and fills every new key from defaults', () => {
      const md = new Markdown('# Hi', { theme: LEGACY_THEME });

      // The caller's 12 keys survive verbatim.
      expect(md.theme.textColor).toBe('#e2e8f0');
      expect(md.theme.fontSize).toBe(16);

      // Keys the caller never heard of are populated, not undefined.
      expect(md.theme.linkColor).toBe('#38bdf8');
      expect(md.theme.syntaxKeywordColor).toBe('#c084fc');
      expect(md.theme.blockGap).toBe(16);
      expect(md.theme.headingSizes).toEqual([32, 28, 24, 20, 18, 16]);
    });

    it('constructs a CodeBlock from the legacy theme without throwing', () => {
      // Regression: `codeLineHeight`/`codePadding` became theme-driven, and a
      // partial theme made `PreparedContentGrid` throw
      // "lineHeight must be a positive finite number" — through a public
      // constructor, so it would have broken real callers, not just this suite.
      expect(() => new CodeBlock('const x = 1;', 'ts', 400, LEGACY_THEME)).not.toThrow();
    });

    it('resolves an empty theme to the full default set', () => {
      const md = new Markdown('x', { theme: {} });
      for (const [key, value] of Object.entries(md.theme)) {
        expect(value, `theme.${key} must be resolved`).toBeDefined();
      }
    });
  });

  describe('colors', () => {
    it('applies linkColor to a paragraph link', () => {
      const md = new Markdown('[text](https://example.com)', {
        theme: { linkColor: '#ff0000' },
      });
      const rt = findRichText(md.content);
      expect(rt).not.toBeNull();
      // Two independent carriers, asserted separately on purpose. The per-span
      // `style.color` shadows the container's `linkColor`, so asserting only
      // the span leaves the container's copy untested — verified by sabotage:
      // reverting `RichText.linkColor` to a hardcoded literal kept a
      // span-only assertion green.
      expect(rt!.spans.some((s) => s.style?.color === '#ff0000')).toBe(true);
      expect(rt!.linkColor).toBe('#ff0000');
    });

    it('applies linkColor to a link inside a heading', () => {
      const md = new Markdown('# [text](https://example.com)', {
        theme: { linkColor: '#00ff00' },
      });
      const rt = findRichText(md.content);
      expect(rt!.spans.some((s) => s.style?.color === '#00ff00')).toBe(true);
    });

    it('applies linkColor to a link inside a list item', () => {
      const md = new Markdown('- [text](https://example.com)', {
        theme: { linkColor: '#0000ff' },
      });
      const rt = findRichText(md.content);
      expect(rt!.spans.some((s) => s.style?.color === '#0000ff')).toBe(true);
    });

    it('applies mathFallbackColor to TeX that could not be typeset', () => {
      // `\notacommand` has no typesetter output, so the source is shown verbatim.
      const md = new Markdown('$\\notacommand{x}$', {
        theme: { mathFallbackColor: '#abcdef' },
      });
      const rt = findRichText(md.content);
      expect(rt).not.toBeNull();
      expect(rt!.spans.some((s) => s.style?.color === '#abcdef')).toBe(true);
    });

    it('applies quoteTextColor to blockquote body text', () => {
      const md = new Markdown('> quoted', {
        theme: { textColor: '#111111', quoteTextColor: '#222222' },
      });
      const rt = findRichText(md.content);
      expect(rt).not.toBeNull();
      expect(rt!.color).toBe('#222222');
    });

    it('leaves text outside a blockquote on textColor', () => {
      // Guards the theme swap in the blockquote arm: it must not leak.
      const md = new Markdown('> quoted\n\nplain', {
        theme: { textColor: '#111111', quoteTextColor: '#222222' },
      });
      const texts = allRichText(md.content);
      expect(texts.length).toBeGreaterThanOrEqual(2);
      expect(texts.some((t) => t.color === '#222222')).toBe(true);
      expect(texts.some((t) => t.color === '#111111')).toBe(true);
    });

    it('defaults quoteTextColor to textColor so a lone textColor override reaches quotes', () => {
      const md = new Markdown('> quoted', { theme: { textColor: '#333333' } });
      const rt = findRichText(md.content);
      expect(rt!.color).toBe('#333333');
    });
  });

  describe('syntax highlighting', () => {
    it('uses the themed keyword color for a code-block keyword', () => {
      const md = new Markdown('```ts\nconst x = 1;\n```', {
        theme: { syntaxKeywordColor: '#ff00ff' },
      });
      const block = md.content.children[0] as CodeBlock;
      const colors = (block as unknown as { lines: { color: string }[][] }).lines
        .flat()
        .map((s) => s.color);
      expect(colors).toContain('#ff00ff');
    });

    it('uses the themed number and comment colors', () => {
      const md = new Markdown('```ts\n// note\nconst x = 42;\n```', {
        theme: { syntaxNumberColor: '#123456', syntaxCommentColor: '#654321' },
      });
      const block = md.content.children[0] as CodeBlock;
      const colors = (block as unknown as { lines: { color: string }[][] }).lines
        .flat()
        .map((s) => s.color);
      expect(colors).toContain('#123456');
      expect(colors).toContain('#654321');
    });
  });

  describe('typography', () => {
    it('drives heading sizes from headingSizes', () => {
      const md = new Markdown('# One\n\n## Two', {
        theme: { headingSizes: [50, 40, 30, 20, 10, 5] },
      });
      const [h1, h2] = allRichText(md.content);
      expect(h1.font).toContain('50px');
      expect(h2.font).toContain('40px');
    });

    it('clamps a heading depth past the end of a short headingSizes array', () => {
      const md = new Markdown('###### Six', {
        theme: { headingSizes: [40, 30] },
      });
      const rt = findRichText(md.content);
      expect(rt!.font).toContain('30px');
    });

    it('falls back to fontSize when headingSizes is empty', () => {
      const md = new Markdown('# One', {
        theme: { headingSizes: [], fontSize: 17 },
      });
      const rt = findRichText(md.content);
      expect(rt!.font).toContain('17px');
    });

    it('derives tableFontSize from fontSize when unset', () => {
      const md = new Markdown('x', { theme: { fontSize: 30 } });
      expect(md.theme.tableFontSize).toBe(28);
    });

    it('honours an explicit tableFontSize over the derivation', () => {
      const md = new Markdown('x', {
        theme: { fontSize: 30, tableFontSize: 11 },
      });
      expect(md.theme.tableFontSize).toBe(11);
    });

    it('never derives a non-positive tableFontSize', () => {
      const md = new Markdown('x', { theme: { fontSize: 1 } });
      expect(md.theme.tableFontSize).toBeGreaterThan(0);
    });

    it('drives the code-block font size and line height from the theme', () => {
      const block = new CodeBlock('const x = 1;\nconst y = 2;', 'ts', 400, {
        codeFontSize: 20,
        codeLineHeight: 40,
      });
      // Two lines at lineHeight 40 plus padding on both sides.
      expect(block.height).toBe(2 * 40 + 2 * 18);
    });
  });

  describe('spacing', () => {
    it('drives the gap between top-level blocks from blockGap', () => {
      const tight = new Markdown('a\n\nb', { theme: { blockGap: 0 } });
      const loose = new Markdown('a\n\nb', { theme: { blockGap: 40 } });
      expect((loose.content as Stack).height).toBeGreaterThan((tight.content as Stack).height);
    });

    it('drives code-block padding from codePadding', () => {
      const a = new CodeBlock('x', 'ts', 400, { codePadding: 0 });
      const b = new CodeBlock('x', 'ts', 400, { codePadding: 30 });
      expect(b.height - a.height).toBe(60);
    });

    it('drives the blockquote accent bar width from quoteBorderWidth', () => {
      const md = new Markdown('> q', { theme: { quoteBorderWidth: 12 } });
      const container = md.content.children[0];
      const border = container.children[0];
      expect(border.width).toBe(12);
    });

    it('drives blockquote indent from quoteIndent', () => {
      const md = new Markdown('> q', { theme: { quoteIndent: 40 } });
      const container = md.content.children[0];
      const innerStack = container.children[1];
      // The child wrapper is offset by the indent.
      expect(innerStack.children[0].children[0].x).toBe(40);
    });

    it('keeps quoteIndent after a width change', () => {
      // `reflowToken` has its OWN indent computation, separate from
      // `renderToken`. Sabotaging only the reflow copy back to a literal `16`
      // left the render-path test above green, so this second assertion is
      // what actually pins it.
      const md = new Markdown('> q', {
        theme: { quoteIndent: 40 },
        maxWidth: 600,
      });
      md.setMaxWidth(400);
      const innerStack = md.content.children[0].children[1];
      expect(innerStack.children[0].children[0].x).toBe(40);
    });

    it('drives the gap between list items from listGap', () => {
      const tight = new Markdown('- a\n- b', { theme: { listGap: 0 } });
      const loose = new Markdown('- a\n- b', { theme: { listGap: 30 } });
      expect(loose.content.children[0].height).toBeGreaterThan(tight.content.children[0].height);
    });

    it('drives code-block corner radius from codeRadius', () => {
      // Only observable through the renderer call — `codeRadius` is not stored
      // on the entity. Without this, hardcoding the radius back to `8` passed
      // the whole suite.
      const block = new CodeBlock('x', 'ts', 400, { codeRadius: 3 });
      const radii: number[] = [];
      block.render({
        beginPath() {},
        roundRect(_x: number, _y: number, _w: number, _h: number, r: number) {
          radii.push(r);
        },
        fill() {},
        fillText() {},
      } as never);
      expect(radii).toContain(3);
    });

    it('drives image corner radius from imageRadius', () => {
      const md = new Markdown('![alt](https://example.com/a.png)', {
        theme: { imageRadius: 21 },
      });
      const img = md.content.children[0].children.find(
        (c: unknown) => (c as { radius?: number }).radius !== undefined,
      );
      expect((img as { radius: number }).radius).toBe(21);
    });

    it('resolves bodyLineHeight for the unknown-block fallback path', () => {
      // Only the resolved value is asserted, not a rendered entity: measured
      // 2026-08-06 with the real `marked` lexer, the `default:` arm of
      // `renderToken` is **unreachable through the public API**. Every block
      // token `marked@18` emits either has its own case or lacks a `text`
      // field (`def` has `tag`/`href`/`title` only), so nothing routes there.
      // A test that constructed a fake token to reach it would assert on a
      // shape the parser never produces.
      const md = new Markdown('x', { theme: { bodyLineHeight: 60 } });
      expect(md.theme.bodyLineHeight).toBe(60);
    });
  });
});
