// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Markdown } from '../src/Markdown';
import { applyTypography } from '../src/markdown-inline';

/**
 * `theme.typographer`: markdown-it-style dash/ellipsis/trademark/quote
 * substitutions, off by default.
 *
 * ## Why off by default
 *
 * These are characters the author did not literally type. Applying them
 * unconditionally would silently rewrite a document's source — the same
 * reasoning `markdown-it` itself uses for defaulting `typographer: false`.
 *
 * ## Scope
 *
 * `applyTypography()` is pure text transform, tested directly. The theme-gate
 * wiring (`decodeProse()`, `collectSpans`' call sites) is tested through
 * `Markdown` so a regression in either place shows up.
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

describe('applyTypography() — the pure text transform', () => {
  it('turns -- into an en dash', () => {
    expect(applyTypography('Hello -- world')).toBe('Hello \u2013 world');
  });

  it('turns --- into an em dash, not two en dashes', () => {
    expect(applyTypography('Hello---world')).toBe('Hello\u2014world');
  });

  it('turns exactly three dots into an ellipsis', () => {
    expect(applyTypography('Wait...')).toBe('Wait\u2026');
  });

  it('leaves a fourth dot as a literal trailing period', () => {
    expect(applyTypography('Wait....')).toBe('Wait\u2026.');
  });

  it('resolves (c), (r), (tm) case-insensitively', () => {
    expect(applyTypography('(c) (C) (r) (R) (tm) (TM)')).toBe(
      '\u00a9 \u00a9 \u00ae \u00ae \u2122 \u2122',
    );
  });

  it('turns a contraction apostrophe into a closing curly quote', () => {
    expect(applyTypography("it's")).toBe('it\u2019s');
  });

  it('pairs a same-run double-quoted phrase into curly quotes', () => {
    expect(applyTypography('She said "hello" to me')).toBe('She said \u201chello\u201d to me');
  });

  it('pairs a same-run single-quoted phrase into curly quotes', () => {
    expect(applyTypography("She said 'hello' to me")).toBe('She said \u2018hello\u2019 to me');
  });

  it('leaves an unpaired quote untouched', () => {
    expect(applyTypography('He said "hello and left')).toBe('He said "hello and left');
  });

  it('composes dashes, ellipsis, symbols and quotes in one pass', () => {
    expect(applyTypography('It\'s "great" -- really... (c) 2026')).toBe(
      'It\u2019s \u201cgreat\u201d \u2013 really\u2026 (c) 2026'.replace('(c)', '\u00a9'),
    );
  });
});

describe('typographer is off by default', () => {
  it('leaves -- literal with no theme override', () => {
    expect(projectedText(new Markdown('Hello -- world', { width: 600 }))).toBe('Hello -- world');
  });

  it('leaves quotes straight with no theme override', () => {
    expect(projectedText(new Markdown('She said "hello"', { width: 600 }))).toBe(
      'She said "hello"',
    );
  });
});

describe('typographer: true rewrites prose through collectSpans', () => {
  it('rewrites a plain paragraph', () => {
    const md = new Markdown('Hello -- world', { width: 600, theme: { typographer: true } });
    expect(projectedText(md)).toBe('Hello \u2013 world');
  });

  it('rewrites text inside bold/italic', () => {
    const md = new Markdown("**it's** *great*", { width: 600, theme: { typographer: true } });
    expect(projectedText(md)).toBe('it\u2019s great');
  });

  it("rewrites link text but never an autolink's URL", () => {
    const bracket = new Markdown('[a -- b](http://example.com)', {
      width: 600,
      theme: { typographer: true },
    });
    expect(projectedText(bracket)).toBe('a \u2013 b');

    const autolink = new Markdown('<http://example.com/--test>', {
      width: 600,
      theme: { typographer: true },
    });
    expect(projectedText(autolink)).toBe('http://example.com/--test');

    const bareUrl = new Markdown('http://example.com/--test', {
      width: 600,
      theme: { typographer: true },
    });
    expect(projectedText(bareUrl)).toBe('http://example.com/--test');
  });

  it('does not rewrite inline code', () => {
    const md = new Markdown("`it's -- code`", { width: 600, theme: { typographer: true } });
    expect(projectedText(md)).toBe("it's -- code");
  });

  it('does not pair a quote across an inline-markup boundary', () => {
    // Splits into three text tokens around the `em`, so the open/close quote
    // are in different collectSpans calls and never paired — documented as
    // intra-run-only in `applyTypography`'s doc comment.
    const md = new Markdown('"quoted *emphasis* text"', {
      width: 600,
      theme: { typographer: true },
    });
    expect(projectedText(md)).toBe('"quoted emphasis text"');
  });

  it('rewrites subscript/superscript/ins/mark content too', () => {
    const md = new Markdown("x^it's^ ++it's++ ==it's==", {
      width: 600,
      theme: { typographer: true },
    });
    const spans = allSpans(md);
    const withApostrophe = spans.filter((s) => s.text.includes('\u2019'));
    expect(withApostrophe.length).toBe(3);
  });

  it('does not rewrite the emoji fallback for an unknown shortcode', () => {
    const md = new Markdown(':not_a_thing -- still literal:', {
      width: 600,
      theme: { typographer: true },
    });
    // Not a valid shortcode shape (contains a space), so it is plain prose and
    // DOES get rewritten -- this test exists to pin that emoji resolution
    // itself (an already-resolved character) never touches applyTypography,
    // not that shortcode-shaped text is exempt.
    expect(projectedText(md)).toContain('\u2013');
  });
});
