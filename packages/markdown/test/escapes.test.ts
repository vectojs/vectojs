// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Markdown } from '../src/Markdown';

/**
 * Backslash escapes render as the literal character, with no syntax visible.
 *
 * There is no `case 'escape'` in the inline switch. This works because
 * `Tokens.Escape.text` holds the character ALREADY unescaped (`\*` lexes to
 * `escape("*")`, verified against marked@18's own lexer) and the `default:` arm
 * happens to push `.text`. So the behaviour is correct by accident, and nothing
 * pinned it: a change to that arm — narrowing it to an allowlist, or making it
 * push `.raw` — would silently turn every escaped character in every document
 * back into visible Markdown syntax.
 *
 * That is exactly the failure mode this package has hit before with `del` and
 * `checkbox`: the content still renders, so the defect reads as plain text rather
 * than as something broken. These tests exist to make it loud.
 *
 * The `\&amp;` case is the one with a second mechanism behind it. It lexes to
 * `escape("&")` + `text("amp;")`, and `decodeEntities` runs on text tokens, so a
 * decoder that ran over the CONCATENATION would collapse the two back into `&`
 * and lose the user's escape. It runs per token, which is what keeps them apart.
 */

function projectedText(md: Markdown): string {
  let out = '';
  const walk = (entity: { children?: unknown[] }): void => {
    const spans = (entity as { spans?: Array<{ text?: string }> }).spans;
    for (const span of spans ?? []) out += span.text ?? '';
    for (const child of entity.children ?? []) walk(child as { children?: unknown[] });
  };
  walk(md as unknown as { children?: unknown[] });
  return out;
}

const render = (src: string) => projectedText(new Markdown(src, { width: 600 }));

describe('backslash escapes', () => {
  it('renders an escaped emphasis marker as a literal asterisk', () => {
    expect(render('a \\* b')).toBe('a * b');
  });

  it('does not italicize text between escaped underscores', () => {
    expect(render('\\_x\\_')).toBe('_x_');
  });

  it('renders an escaped hash without making a heading', () => {
    // The whole line stays one paragraph — an escaped `#` must not reach the block
    // lexer as a heading marker.
    expect(render('\\# not a heading')).toBe('# not a heading');
  });

  it('renders escaped brackets as literals', () => {
    expect(render('\\[not a link\\]')).toBe('[not a link]');
  });

  it('renders an escaped backslash as one backslash', () => {
    expect(render('a \\\\ b')).toBe('a \\ b');
  });

  it('renders escaped backticks without opening a code span', () => {
    expect(render('\\`code\\`')).toBe('`code`');
  });

  it('keeps an escaped ampersand from being decoded as an entity', () => {
    // `\&amp;` must show the six characters the author wrote, not `&`. The escape
    // and the `amp;` arrive as two tokens and `decodeEntities` sees only the
    // second, so the entity pattern is never complete in either one.
    expect(render('\\&amp;')).toBe('&amp;');
  });

  it('still decodes a real entity that was not escaped', () => {
    // The control for the test above: without it, a decoder that had simply stopped
    // working would make that assertion pass for the wrong reason.
    expect(render('&amp;')).toBe('&');
  });
});
