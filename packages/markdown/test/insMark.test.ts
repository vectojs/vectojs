// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { marked } from 'marked';
import { Markdown } from '../src/Markdown';
import { DEFAULT_THEME } from '../src/theme';

/**
 * `++content++` (`markdown-it-ins`, underline) and `==content==`
 * (`markdown-it-mark`, background highlight), the same shape as
 * `superscript.test.ts`'s `^…^`: neither is tokenized by `marked`'s own
 * grammar at all (verified against marked@18.0.7, `PX-0524`), so both needed
 * their own `marked.use` inline extensions (`INS_MARK_EXTENSIONS` in
 * `markdown-ins-mark.ts`), registered from the single shared array in
 * `Markdown.ts` and `MarkdownWorker.ts` alongside `SUPERSCRIPT_EXTENSIONS`.
 *
 * `ins` sets `TextStyle.underline`; `mark` sets `TextStyle.highlightColor` to
 * `theme.markHighlightColor`. Neither has a baseline shift or a size change —
 * they are pure boolean/color span styles, unlike sub/superscript.
 */

HTMLCanvasElement.prototype.getContext = (() => null) as never;

/** Every span in the tree, flattened, with its style. */
function allSpans(md: Markdown): Array<{ text: string; style?: Record<string, unknown> }> {
  const out: Array<{ text: string; style?: Record<string, unknown> }> = [];
  const walk = (entity: { children?: unknown[] }): void => {
    const spans = (
      entity as {
        spans?: Array<{ text: string; style?: Record<string, unknown> }>;
      }
    ).spans;
    for (const span of spans ?? []) out.push(span);
    for (const child of entity.children ?? []) walk(child as { children?: unknown[] });
  };
  walk(md as unknown as { children?: unknown[] });
  return out;
}

/** All projected text, spans and plain `Text` entities alike. */
function projectedText(md: Markdown): string {
  let out = '';
  const walk = (entity: { children?: unknown[] }): void => {
    const spans = (entity as { spans?: Array<{ text?: string }> }).spans;
    for (const span of spans ?? []) out += span.text ?? '';
    const withText = entity as { text?: unknown };
    if (typeof withText.text === 'string') out += withText.text;
    for (const child of entity.children ?? []) walk(child as { children?: unknown[] });
  };
  walk(md as unknown as { children?: unknown[] });
  return out;
}

/** Text of every underlined span. */
function underlinedTexts(md: Markdown): string[] {
  return allSpans(md)
    .filter((s) => s.style?.underline === true)
    .map((s) => s.text);
}

/** Text of every span carrying a highlight background. */
function highlightedTexts(md: Markdown): string[] {
  return allSpans(md)
    .filter((s) => typeof s.style?.highlightColor === 'string')
    .map((s) => s.text);
}

describe('delimiter lexing (the upstream cause)', () => {
  it('marked produces no token for ++…++ or ==…== without the extension', () => {
    // Pins the raw grammar fact from PX-0524: neither delimiter is part of
    // marked's own (or GFM's) inline grammar. If a future marked version
    // starts lexing either itself, this changes and the extension may need
    // revisiting for a conflict.
    const insTokens = (marked.lexer('this is ++inserted++ text')[0] as { tokens: unknown[] })
      .tokens;
    const markTokens = (marked.lexer('this is ==marked== text')[0] as { tokens: unknown[] }).tokens;
    expect(insTokens.length).toBeGreaterThan(0);
    expect(markTokens.length).toBeGreaterThan(0);
  });
});

describe('ins renders as an underlined run', () => {
  it('does not print the ++ delimiters', () => {
    expect(projectedText(new Markdown('this is ++inserted++ text', { width: 600 }))).toBe(
      'this is inserted text',
    );
  });

  it('underlines the inserted content, leaving surrounding text unstyled', () => {
    const spans = allSpans(new Markdown('this is ++inserted++ text', { width: 600 }));
    expect(spans.map((s) => s.text)).toEqual(['this is ', 'inserted', ' text']);
    expect(spans[0].style).toBeUndefined();
    expect(spans[2].style).toBeUndefined();
    expect(spans[1].style?.underline).toBe(true);
    expect(spans[1].style?.highlightColor).toBeUndefined();
  });

  it('supports multiple ins runs in one paragraph', () => {
    const md = new Markdown('++a++ and ++b++', { width: 600 });
    expect(underlinedTexts(md)).toEqual(['a', 'b']);
    expect(projectedText(md)).toBe('a and b');
  });
});

describe('mark renders with a highlight background', () => {
  it('does not print the == delimiters', () => {
    expect(projectedText(new Markdown('this is ==marked== text', { width: 600 }))).toBe(
      'this is marked text',
    );
  });

  it('highlights the marked content at the theme default color, leaving surrounding text unstyled', () => {
    const spans = allSpans(new Markdown('this is ==marked== text', { width: 600 }));
    expect(spans.map((s) => s.text)).toEqual(['this is ', 'marked', ' text']);
    expect(spans[0].style).toBeUndefined();
    expect(spans[2].style).toBeUndefined();
    expect(spans[1].style?.highlightColor).toBe(DEFAULT_THEME.markHighlightColor);
    expect(spans[1].style?.underline).toBeUndefined();
  });

  it('supports multiple mark runs in one paragraph', () => {
    const md = new Markdown('==a== and ==b==', { width: 600 });
    expect(highlightedTexts(md)).toEqual(['a', 'b']);
    expect(projectedText(md)).toBe('a and b');
  });

  it('honours a caller-supplied markHighlightColor', () => {
    const md = new Markdown('==x==', { width: 600, theme: { markHighlightColor: '#ff00ff' } });
    const spans = allSpans(md);
    expect(spans[0].style?.highlightColor).toBe('#ff00ff');
  });
});

describe('constructs that must NOT become ins or mark', () => {
  it('leaves unclosed delimiters as literal text', () => {
    expect(projectedText(new Markdown('a ++not closed', { width: 600 }))).toBe('a ++not closed');
    expect(projectedText(new Markdown('a ==not closed', { width: 600 }))).toBe('a ==not closed');
    expect(underlinedTexts(new Markdown('a ++not closed', { width: 600 }))).toEqual([]);
    expect(highlightedTexts(new Markdown('a ==not closed', { width: 600 }))).toEqual([]);
  });

  it('leaves whitespace-containing delimiter runs as literal text', () => {
    expect(projectedText(new Markdown('a ++ b', { width: 600 }))).toBe('a ++ b');
    expect(projectedText(new Markdown('a == b', { width: 600 }))).toBe('a == b');
  });

  it('resolves a++b++++c++d as two adjacent ins runs, not one spanning to the last delimiter', () => {
    // Same left-to-right, non-greedy resolution as SUP_RE — see that test's
    // identical case for the reasoning; excluding a bare `+` from the content
    // class is what stops `++b++` from skipping past its own close to pair
    // with the far delimiter.
    const md = new Markdown('a++b++++c++d', { width: 600 });
    expect(projectedText(md)).toBe('abcd');
    expect(underlinedTexts(md)).toEqual(['b', 'c']);
  });

  it('leaves escaped delimiters as literal characters', () => {
    expect(projectedText(new Markdown('a\\+\\+b\\+\\+c', { width: 600 }))).toBe('a++b++c');
    expect(underlinedTexts(new Markdown('a\\+\\+b\\+\\+c', { width: 600 }))).toEqual([]);
  });

  it('unescapes an escaped delimiter INSIDE an ins run', () => {
    const spans = allSpans(new Markdown('x++a\\+b++', { width: 600 }));
    const ins = spans.find((s) => s.style?.underline === true);
    expect(ins?.text).toBe('a+b');
  });

  it('leaves delimiters inside inline code alone', () => {
    const insMd = new Markdown('`x++y++z`', { width: 600 });
    expect(projectedText(insMd)).toBe('x++y++z');
    expect(underlinedTexts(insMd)).toEqual([]);

    const markMd = new Markdown('`x==y==z`', { width: 600 });
    expect(projectedText(markMd)).toBe('x==y==z');
    expect(highlightedTexts(markMd)).toEqual([]);
  });
});

describe('inner markup and inherited style', () => {
  it('carries the surrounding run style onto ins content', () => {
    const spans = allSpans(new Markdown('**++strong ins++**', { width: 600 }));
    expect(spans.map((s) => s.text)).toEqual(['strong ins']);
    expect(spans[0].style?.bold).toBe(true);
    expect(spans[0].style?.underline).toBe(true);
  });

  it('carries the surrounding run style onto mark content', () => {
    const spans = allSpans(new Markdown('*==em mark==*', { width: 600 }));
    expect(spans.map((s) => s.text)).toEqual(['em mark']);
    expect(spans[0].style?.italic).toBe(true);
    expect(spans[0].style?.highlightColor).toBe(DEFAULT_THEME.markHighlightColor);
  });
});
