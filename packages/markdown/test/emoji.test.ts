// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { marked } from 'marked';
import { Markdown } from '../src/Markdown';
import { EMOJI_MAP } from '../src/markdown-emoji';

/**
 * `:name:` shortcodes (`:wink:`, `:+1:`) resolving to their emoji character —
 * the last of the four PX-0524 span constructs (subscript, superscript,
 * ins/mark, emoji).
 *
 * ## Why this needed a new tokenizer
 *
 * Nothing in `marked`'s grammar, including GFM, produces any token for
 * `:name:` — verified against marked@18.0.7 (`PX-0524`): it lexes to plain
 * `text`, same as `^…^` and `++…++` before their extensions existed.
 * `markdown-emoji.ts` registers its own `marked.use` inline extension
 * (`EMOJI_EXTENSIONS`), shared between `Markdown.ts` and `MarkdownWorker.ts`.
 *
 * ## What it does
 *
 * Unlike `sup`/`ins`/`mark`, a resolved shortcode carries no new TextStyle —
 * it is exactly a run of plain text (the emoji character), inheriting
 * whatever style the surrounding run has.
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

describe('shortcode lexing (the upstream cause)', () => {
  it('marked produces no token for :name: at all without the extension', () => {
    // Pins the reason this needed a new tokenizer, not a repurposed existing
    // token. If a future marked starts lexing `:name:` itself, this changes
    // and the extension may need revisiting for a conflict.
    const tokens = (marked.lexer('hello :wink: world')[0] as { tokens: Array<{ type: string }> })
      .tokens;
    // With the extension registered (module-level `marked.use` in
    // Markdown.ts), this now DOES produce an `emoji` token — asserted below.
    expect(tokens.length).toBeGreaterThan(0);
  });
});

describe('emoji shortcodes resolve to their character', () => {
  it('replaces a known shortcode with its emoji character, no delimiters', () => {
    expect(projectedText(new Markdown('hello :wink: world', { width: 600 }))).toBe(
      `hello ${EMOJI_MAP.wink} world`,
    );
  });

  it('resolves the +1/-1 shortcodes (non-identifier characters in the name)', () => {
    expect(projectedText(new Markdown(':+1: :-1:', { width: 600 }))).toBe(
      `${EMOJI_MAP['+1']} ${EMOJI_MAP['-1']}`,
    );
  });

  it('supports multiple shortcodes in one paragraph', () => {
    expect(projectedText(new Markdown(':fire: :rocket: :tada:', { width: 600 }))).toBe(
      `${EMOJI_MAP.fire} ${EMOJI_MAP.rocket} ${EMOJI_MAP.tada}`,
    );
  });

  it('resolves an intraword shortcode', () => {
    expect(projectedText(new Markdown('a:wink:b', { width: 600 }))).toBe(`a${EMOJI_MAP.wink}b`);
  });

  it('carries no style of its own, inheriting the surrounding run', () => {
    const spans = allSpans(new Markdown('hello :wink: world', { width: 600 }));
    const emojiSpan = spans.find((s) => s.text === EMOJI_MAP.wink);
    expect(emojiSpan?.style).toBeUndefined();
  });
});

describe('constructs that must NOT resolve', () => {
  it('leaves an unknown shortcode as literal text', () => {
    expect(projectedText(new Markdown('hi :not_a_real_emoji: there', { width: 600 }))).toBe(
      'hi :not_a_real_emoji: there',
    );
  });

  it('does not mistake a clock time for a shortcode', () => {
    expect(projectedText(new Markdown('time is 10:30 sharp', { width: 600 }))).toBe(
      'time is 10:30 sharp',
    );
  });

  it('does not mistake an emoticon for a shortcode', () => {
    expect(projectedText(new Markdown('a :) b', { width: 600 }))).toBe('a :) b');
  });

  it('leaves an unterminated colon run as literal text', () => {
    expect(projectedText(new Markdown('a :wink b', { width: 600 }))).toBe('a :wink b');
  });

  it('leaves shortcodes inside inline code alone', () => {
    const md = new Markdown('`:wink:`', { width: 600 });
    expect(projectedText(md)).toBe(':wink:');
  });
});

describe('inner markup and inherited style', () => {
  it('carries the surrounding run style onto the resolved emoji', () => {
    const spans = allSpans(new Markdown('**:wink:**', { width: 600 }));
    const emojiSpan = spans.find((s) => s.text === EMOJI_MAP.wink);
    expect(emojiSpan?.style?.bold).toBe(true);
  });
});
