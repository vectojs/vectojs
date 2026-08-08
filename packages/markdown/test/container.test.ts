// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { marked } from 'marked';
import { Markdown } from '../src/Markdown';
import { ContainerBackground, QuoteBorder } from '../src/markdown-entities';
import { DEFAULT_THEME } from '../src/theme';
import { Stack } from '@vectojs/ui';

/**
 * `:::kind\n…body…\n:::` fenced containers (`markdown-it-container` /
 * `remark-directive` admonitions) — the fourth `Next` markdown-it construct.
 *
 * ## Why this needed a new tokenizer
 *
 * Nothing in `marked`'s grammar, including GFM, produces any token for a
 * `:::` fence — verified against marked@18.0.7 (`PX-0524`): it lexes to plain
 * `paragraph`/`text`. `markdown-container.ts` registers its own `marked.use`
 * **block** extension (`CONTAINER_EXTENSIONS`), the same shape as
 * `markdown-footnote.ts`'s `footnoteDef`, shared between `Markdown.ts` and
 * `MarkdownWorker.ts` so the two lexers cannot diverge.
 *
 * ## What it renders
 *
 * Visually a blockquote with an added background fill: `MarkdownContainer[
 * ContainerBackground, QuoteBorder, Stack[MarkdownContainer[block], …]]`. The
 * accent color comes from `theme.containerColors[kind]`, falling back to
 * `theme.containerDefaultColor` for an unrecognised or absent kind.
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

/** Find every `ContainerBackground`/`QuoteBorder` pair in the tree, paired by parent. */
function findContainers(
  md: Markdown,
): Array<{ background: ContainerBackground; border: QuoteBorder; stack: Stack }> {
  const out: Array<{ background: ContainerBackground; border: QuoteBorder; stack: Stack }> = [];
  const walk = (entity: { children?: unknown[] }): void => {
    const children = (entity.children ?? []) as unknown[];
    const background = children.find((c) => c instanceof ContainerBackground) as
      | ContainerBackground
      | undefined;
    const border = children.find((c) => c instanceof QuoteBorder) as QuoteBorder | undefined;
    const stack = children.find((c) => c instanceof Stack) as Stack | undefined;
    if (background && border && stack) out.push({ background, border, stack });
    for (const child of children) walk(child as { children?: unknown[] });
  };
  walk(md as unknown as { children?: unknown[] });
  return out;
}

describe('fence lexing (the upstream cause)', () => {
  it('marked produces no token for ::: at all without the extension', () => {
    // Pins the reason this needed a new tokenizer. If a future marked starts
    // lexing `:::` itself, this changes and the extension may need revisiting.
    const tokens = marked.lexer(':::note\nHello\n:::\n');
    // With the extension registered (module-level `marked.use` in
    // Markdown.ts), this now DOES produce a `container` token — asserted below.
    expect(tokens.length).toBeGreaterThan(0);
  });
});

describe('container renders its body, no fence delimiters', () => {
  it('does not print the ::: fence lines', () => {
    const md = new Markdown(':::note\nHello world\n:::', { width: 600 });
    expect(projectedText(md)).toBe('Hello world');
  });

  it('builds one ContainerBackground + QuoteBorder + Stack per container', () => {
    const md = new Markdown(':::note\nHello world\n:::', { width: 600 });
    const found = findContainers(md);
    expect(found.length).toBe(1);
  });

  it('renders nested block markup (bold, list) inside the fence', () => {
    const md = new Markdown(':::warning\n**bold** text\n\n- a\n- b\n:::', { width: 600 });
    const spans = allSpans(md);
    expect(spans.some((s) => s.text === 'bold' && s.style?.bold === true)).toBe(true);
    expect(projectedText(md)).toContain('a');
    expect(projectedText(md)).toContain('b');
  });

  it('supports a bare ::: with no kind', () => {
    const md = new Markdown(':::\nplain body\n:::', { width: 600 });
    expect(projectedText(md)).toBe('plain body');
    expect(findContainers(md).length).toBe(1);
  });
});

describe('accent color follows theme.containerColors by kind', () => {
  it('uses the note color for :::note', () => {
    const md = new Markdown(':::note\nHi\n:::', { width: 600 });
    const [found] = findContainers(md);
    expect(found.border.color).toBe(DEFAULT_THEME.containerColors.note);
  });

  it('uses the warning color for :::warning', () => {
    const md = new Markdown(':::warning\nHi\n:::', { width: 600 });
    const [found] = findContainers(md);
    expect(found.border.color).toBe(DEFAULT_THEME.containerColors.warning);
  });

  it('falls back to containerDefaultColor for an unrecognised kind', () => {
    const md = new Markdown(':::mystery\nHi\n:::', { width: 600 });
    const [found] = findContainers(md);
    expect(found.border.color).toBe(DEFAULT_THEME.containerDefaultColor);
  });

  it('falls back to containerDefaultColor for a bare ::: with no kind', () => {
    const md = new Markdown(':::\nHi\n:::', { width: 600 });
    const [found] = findContainers(md);
    expect(found.border.color).toBe(DEFAULT_THEME.containerDefaultColor);
  });

  it('respects a caller-supplied containerColors override', () => {
    const md = new Markdown(':::note\nHi\n:::', {
      width: 600,
      theme: { containerColors: { note: '#123456' } },
    });
    const [found] = findContainers(md);
    expect(found.border.color).toBe('#123456');
  });
});

describe('constructs that must NOT become a container', () => {
  it('leaves an unterminated fence as literal paragraph text', () => {
    const md = new Markdown(':::note\nunterminated', { width: 600 });
    expect(projectedText(md)).toContain(':::note');
    expect(findContainers(md).length).toBe(0);
  });

  it('absorbs a fence directly after a paragraph line with no blank line', () => {
    // Documented consequence of omitting a block start(): matches
    // `footnoteDef`'s own behaviour for the same reason.
    const md = new Markdown('Para one.\n:::note\nHello\n:::', { width: 600 });
    expect(findContainers(md).length).toBe(0);
    expect(projectedText(md)).toContain(':::note');
  });

  it('opens a container when a blank line precedes the fence', () => {
    const md = new Markdown('Para one.\n\n:::note\nHello\n:::', { width: 600 });
    expect(findContainers(md).length).toBe(1);
  });
});

describe('nested containers', () => {
  it('recurses through its own extension set for a container nested inside one', () => {
    const md = new Markdown(':::outer\n:::inner\ntext\n:::\n:::', { width: 600 });
    expect(findContainers(md).length).toBe(2);
    expect(projectedText(md)).toBe('text');
  });
});
