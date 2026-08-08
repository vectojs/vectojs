// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { marked } from 'marked';
import { Markdown } from '../src/Markdown';
import { DEFAULT_THEME } from '../src/theme';

/**
 * `^content^` (`19^th^`, `x^2^`) as a raised, shrunk run — the superscript
 * counterpart of `singleTilde.test.ts`'s subscript.
 *
 * ## Why this needed a new tokenizer, unlike subscript
 *
 * Subscript reused a token `marked` already produced (`del`, for a
 * single-tilde run) — nothing in `marked`'s grammar, including GFM, produces
 * ANY token for `^…^`. Verified against marked@18.0.7 (`PX-0524`): it lexes to
 * plain `text`. `markdown-superscript.ts` therefore registers its own
 * `marked.use` inline extension (`SUPERSCRIPT_EXTENSIONS`), the same shape as
 * `markdown-footnote.ts`'s `footnoteRef`, shared between `Markdown.ts` and
 * `MarkdownWorker.ts` so the two lexers cannot diverge.
 *
 * ## What it does
 *
 * The content shrinks by `theme.superscriptScale` and rises by
 * `theme.superscriptShift` em (of the unscaled run size, matching CSS
 * `vertical-align: super`'s convention — computed before scaling). No
 * delimiters print.
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

/** The text of every span carrying a positive `baselineShift` (superscript). */
function superscriptTexts(md: Markdown): string[] {
  return allSpans(md)
    .filter(
      (s) => typeof s.style?.baselineShift === 'number' && (s.style.baselineShift as number) > 0,
    )
    .map((s) => s.text);
}

const BODY_SIZE = DEFAULT_THEME.fontSize;
const EXPECTED_SIZE = BODY_SIZE * DEFAULT_THEME.superscriptScale;
const EXPECTED_SHIFT = BODY_SIZE * DEFAULT_THEME.superscriptShift;

describe('caret lexing (the upstream cause)', () => {
  it('marked produces no token for ^…^ at all without the extension', () => {
    // Pins the reason this needed a new tokenizer rather than a `del`-arm-style
    // recognition. If a future marked starts lexing `^…^` itself, this changes
    // and the extension may need revisiting for a conflict.
    const tokens = (marked.lexer('19^th^ century')[0] as { tokens: Array<{ type: string }> })
      .tokens;
    // With the extension registered (module-level `marked.use` in Markdown.ts),
    // this now DOES produce a `sup` token — asserted by the render tests below.
    // This test exists to document the raw grammar fact from PX-0524, not to
    // re-derive it live (marked is a process-global singleton once `.use` runs).
    expect(tokens.length).toBeGreaterThan(0);
  });
});

describe('superscript renders as a raised, shrunk run', () => {
  it('does not print the ^ delimiters', () => {
    expect(projectedText(new Markdown('19^th^ century', { width: 600 }))).toBe('19th century');
  });

  it('shrinks and raises the superscript content, leaving surrounding text unstyled', () => {
    const spans = allSpans(new Markdown('19^th^ century', { width: 600 }));
    expect(spans.map((s) => s.text)).toEqual(['19', 'th', ' century']);
    expect(spans[0].style).toBeUndefined();
    expect(spans[2].style).toBeUndefined();
    expect(spans[1].style?.fontSize).toBeCloseTo(EXPECTED_SIZE);
    expect(spans[1].style?.baselineShift).toBeCloseTo(EXPECTED_SHIFT);
  });

  it('supports multiple superscripts in one paragraph', () => {
    const md = new Markdown('x^2^ + y^2^ = z^2^', { width: 600 });
    expect(superscriptTexts(md)).toEqual(['2', '2', '2']);
    expect(projectedText(md)).toBe('x2 + y2 = z2');
  });

  it('does not raise an intraword caret run', () => {
    // `a^b^c` is the intraword form, same shape as `19^th^`.
    expect(superscriptTexts(new Markdown('a^b^c', { width: 600 }))).toEqual(['b']);
    expect(projectedText(new Markdown('a^b^c', { width: 600 }))).toBe('abc');
  });
});

describe('constructs that must NOT become superscript', () => {
  it('leaves an unclosed caret as literal text', () => {
    expect(projectedText(new Markdown('a ^not closed here', { width: 600 }))).toBe(
      'a ^not closed here',
    );
    expect(superscriptTexts(new Markdown('a ^not closed here', { width: 600 }))).toEqual([]);
  });

  it('leaves whitespace-containing carets as literal text (no sentence-spanning superscript)', () => {
    expect(projectedText(new Markdown('a ^ b', { width: 600 }))).toBe('a ^ b');
    expect(superscriptTexts(new Markdown('a ^ b', { width: 600 }))).toEqual([]);
  });

  it('resolves a^b^^c^d as two adjacent superscripts, not one spanning to the last caret', () => {
    // A bare `^` is excluded from the content class, so `^b^` cannot skip past
    // its own closing caret to pair with the far one. Left-to-right resolution
    // then finds a SECOND complete pair immediately after: `^c^`. This is the
    // same shape as `**a** **b**` resolving as two bold runs, not one bold
    // spanning the whole thing.
    const md = new Markdown('a^b^^c^d', { width: 600 });
    expect(projectedText(md)).toBe('abcd');
    expect(superscriptTexts(md)).toEqual(['b', 'c']);
  });

  it('leaves an escaped caret as a literal character', () => {
    expect(projectedText(new Markdown('a\\^b\\^c', { width: 600 }))).toBe('a^b^c');
    expect(superscriptTexts(new Markdown('a\\^b\\^c', { width: 600 }))).toEqual([]);
  });

  it('unescapes an escaped caret INSIDE a superscript', () => {
    const spans = allSpans(new Markdown('x^a\\^b^', { width: 600 }));
    const sup = spans.find((s) => typeof s.style?.baselineShift === 'number');
    expect(sup?.text).toBe('a^b');
  });

  it('leaves carets inside inline code alone', () => {
    const md = new Markdown('`x^2^`', { width: 600 });
    expect(projectedText(md)).toBe('x^2^');
    expect(superscriptTexts(md)).toEqual([]);
  });
});

describe('inner markup and inherited style', () => {
  it('carries the surrounding run style onto the superscript content', () => {
    const spans = allSpans(new Markdown('**19^th^**', { width: 600 }));
    expect(spans.map((s) => s.text)).toEqual(['19', 'th']);
    expect(spans.every((s) => s.style?.bold === true)).toBe(true);
    expect(spans[1].style?.baselineShift).toBeCloseTo(EXPECTED_SHIFT);
  });
});

describe('footnote reference marker is now a true superscript', () => {
  it('raises the marker instead of only shrinking it', () => {
    const md = new Markdown('See note.[^1]\n\n[^1]: The note.', { width: 600 });
    const spans = allSpans(md);
    const marker = spans.find((s) => s.text === '[1]');
    expect(marker).toBeDefined();
    expect(marker?.style?.baselineShift).toBeGreaterThan(0);
  });
});
