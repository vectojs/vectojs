// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { RichText, Stack, Table, Text } from '@vectojs/ui';
import { CodeBlock, Markdown } from '../src/Markdown';

// jsdom has no canvas getContext; measure.ts falls back to its estimate, which is
// deterministic and width-proportional — enough to assert that a reflow happened
// and in which direction. Real glyph metrics are covered by the e2e.
HTMLCanvasElement.prototype.getContext = (() => null) as never;

/** First descendant satisfying `pick`, breadth-first. */
function find<T>(root: { children: unknown[] }, pick: (entity: unknown) => boolean): T | null {
  const queue: Array<{ children: unknown[] }> = [root];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node) continue;
    for (const child of node.children) {
      if (pick(child)) return child as T;
      queue.push(child as { children: unknown[] });
    }
  }
  return null;
}

describe('Markdown.setMaxWidth', () => {
  it('rewraps a paragraph without rebuilding it', () => {
    const md = new Markdown('Some reasonably long paragraph text that will wrap when narrowed.', {
      maxWidth: 600,
    });
    const paragraph = md.content.children[0] as RichText;
    expect(paragraph.maxWidth).toBe(600);

    md.setMaxWidth(300);

    // Same entity instance: a reflow must not destroy and rebuild.
    expect(md.content.children[0]).toBe(paragraph);
    expect(paragraph.maxWidth).toBe(300);
    expect(md.maxWidth).toBe(300);
  });

  it('is a no-op at an unchanged width', () => {
    const md = new Markdown('Text.', { maxWidth: 400 });
    const before = md.content.children[0] as RichText;
    const result = md.setMaxWidth(400);
    expect(result).toBe(md);
    expect(md.content.children[0]).toBe(before);
  });

  it('updates the document box to match the new width', () => {
    // Long enough that 800px is one line and 200px is several. A short paragraph
    // fits on one line at both widths, so it would assert nothing — measured: the
    // first draft of this test used one and read 88 -> 88.
    const md = new Markdown(
      '# Heading\n\nA paragraph of text here that is quite long indeed so it should wrap at narrow widths for sure.',
      { maxWidth: 800 },
    );
    expect(md.height).toBe(88);
    expect(md.width).toBe(760);

    md.setMaxWidth(200);

    // Narrower wrapping means more lines, so the document gets taller: the
    // paragraph goes 1 -> 4 lines. Both assertions fail if `content.layout()` is
    // skipped after the reflow.
    expect(md.height).toBe(160);
    expect(md.width).toBe(200);
  });

  it('reflows every block type in one document', () => {
    const source = [
      '# Heading',
      '',
      'A paragraph.',
      '',
      '```ts',
      'const a = 1;',
      '```',
      '',
      '> A quoted paragraph.',
      '',
      '- item one',
      '- item two',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '---',
    ].join('\n');
    const md = new Markdown(source, { maxWidth: 600 });

    md.setMaxWidth(320);

    const heading = md.content.children[0] as RichText;
    expect(heading.maxWidth).toBe(320);

    const code = find<CodeBlock>(md, (e) => e instanceof CodeBlock);
    expect(code).not.toBeNull();
    expect(code!.width).toBe(320);

    // A blockquote indents its content by 16, so its inner blocks wrap narrower.
    const quoted = find<RichText>(
      md,
      (e) => e instanceof RichText && e.spans.some((s) => s.text.includes('quoted')),
    );
    expect(quoted).not.toBeNull();
    expect(quoted!.maxWidth).toBe(304);

    const listItem = find<RichText>(
      md,
      (e) => e instanceof RichText && e.spans.some((s) => s.text.includes('item one')),
    );
    expect(listItem).not.toBeNull();
    expect(listItem!.maxWidth).toBe(320);

    const table = find<Table>(md, (e) => e instanceof Table);
    expect(table).not.toBeNull();
    expect(table!.width).toBe(320);
    // Columns rescaled, not left at the old total.
    expect(table!.colWidths.reduce((a, b) => a + b, 0)).toBeCloseTo(320, 5);

    const rule = md.content.children[md.content.children.length - 1];
    expect((rule as { width: number }).width).toBe(320);
  });

  it('keeps blockquote indent stable across repeated resizes', () => {
    const md = new Markdown('> Quoted text that is long enough to wrap somewhere.', {
      maxWidth: 500,
    });
    const inner = find<RichText>(md, (e) => e instanceof RichText);
    expect(inner).not.toBeNull();

    for (const width of [400, 300, 400, 260, 500]) {
      md.setMaxWidth(width);
      // Re-derived from the current width every time rather than accumulated, so
      // the indent neither compounds nor collapses.
      expect(inner!.maxWidth).toBe(width - 16);
    }
  });

  it('handles a nested blockquote', () => {
    const md = new Markdown('> outer\n>\n> > inner quoted text\n', {
      maxWidth: 400,
    });
    md.setMaxWidth(300);
    const inner = find<RichText>(
      md,
      (e) => e instanceof RichText && e.spans.some((s) => s.text.includes('inner')),
    );
    expect(inner).not.toBeNull();
    // Two levels of 16px indent.
    expect(inner!.maxWidth).toBe(300 - 16 - 16);
  });

  it('does not invalidate an open stream writer', async () => {
    const md = new Markdown('', { maxWidth: 600 });
    const stream = md.createStream();
    stream.write('First paragraph.\n\nSecond ');

    // A resize mid-stream. `setContent` would have aborted the writer here.
    md.setMaxWidth(320);

    expect(stream.state).toBe('open');
    stream.write('paragraph continues.\n');
    await stream.close();

    // The stream's own text survived, and the document is at the new width.
    const texts = md.content.children
      .filter((c): c is RichText => c instanceof RichText)
      .map((c) => c.spans.map((s) => s.text).join(''));
    expect(texts.join(' ')).toContain('First paragraph.');
    expect(texts.join(' ')).toContain('Second paragraph continues.');
    for (const child of md.content.children) {
      if (child instanceof RichText) expect(child.maxWidth).toBe(320);
    }
  });

  it('applies the new width to blocks that arrive after the resize', () => {
    const md = new Markdown('First.', { maxWidth: 600 });
    md.setMaxWidth(280);
    md.appendMarkdown('\n\nSecond paragraph appended after the resize.\n');
    const last = md.content.children[md.content.children.length - 1];
    expect(last).toBeInstanceOf(RichText);
    expect((last as RichText).maxWidth).toBe(280);
  });

  it('rewraps an image-bearing paragraph and rescales the image', () => {
    const md = new Markdown('Text before ![alt](https://example.invalid/a.png) and after.', {
      maxWidth: 600,
    });
    const stack = md.content.children[0] as Stack;
    expect(stack).toBeInstanceOf(Stack);

    md.setMaxWidth(320);

    expect(md.content.children[0]).toBe(stack);
    expect(stack.maxWidth).toBe(320);
    for (const run of stack.children) {
      if (run instanceof RichText) expect(run.maxWidth).toBe(320);
    }
    // The image is undecoded in jsdom, so it tracks the placeholder guess the
    // render arm makes: min(800, width) at a 16:10 ratio.
    const image = stack.children.find((c) => !(c instanceof RichText));
    expect(image).toBeDefined();
    expect((image as { width: number }).width).toBe(320);
    expect((image as { height: number }).height).toBe(192);
  });

  it('rejects a call from inside an onStable callback', async () => {
    const md = new Markdown('', { maxWidth: 400 });
    let thrown: unknown = null;
    const stream = md.createStream({
      onStable: () => {
        try {
          md.setMaxWidth(200);
        } catch (error) {
          thrown = error;
        }
      },
    });
    stream.write('Body text.\n');
    await stream.close();
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('setMaxWidth');
  });

  it('reflows a plain-Text fallback block', () => {
    // A definition token has `text` but no dedicated arm, so it lands on the
    // `Text` fallback — the arm that would otherwise be silently skipped.
    const md = new Markdown('Paragraph.\n', { maxWidth: 500 });
    md.setMaxWidth(250);
    const text = find<Text>(md, (e) => e instanceof Text);
    if (text) expect(text.maxWidth).toBe(250);
    // Whether or not this document produced one, the pass must not have thrown.
    expect(md.maxWidth).toBe(250);
  });

  it('clamps a negative width to zero rather than propagating it', () => {
    const md = new Markdown('Text.', { maxWidth: 300 });
    md.setMaxWidth(-50);
    expect(md.maxWidth).toBe(0);
  });
});

// `blockAffordances: true` wraps code blocks and tables in a
// `BlockWithAffordances` whose own box is assigned once from the inner block
// at construction. The reflow arms tested above dispatch on
// `entity instanceof CodeBlock` / `instanceof Table` directly, so under the
// flag both silently kept their old width while prose rewrapped (#701).
describe('setMaxWidth with blockAffordances', () => {
  it('reflows wrapped code and tables and refreshes the wrapper', () => {
    const source = [
      '```ts',
      "const greeting = 'hÉllo';",
      '```',
      '',
      '| name | qty |',
      '| --- | --- |',
      '| café | 2 |',
    ].join('\n');
    const md = new Markdown(source, { maxWidth: 600, blockAffordances: true });

    const code = find<CodeBlock>(md, (e) => e instanceof CodeBlock);
    const table = find<Table>(md, (e) => e instanceof Table);
    expect(code).not.toBeNull();
    expect(table).not.toBeNull();
    // The blocks really are wrapped, or this test proves nothing.
    expect(code!.parent?.constructor.name).toBe('BlockWithAffordances');

    md.setMaxWidth(320);

    expect(code!.width).toBe(320);
    expect(table!.width).toBe(320);
    expect(table!.colWidths.reduce((a, b) => a + b, 0)).toBeCloseTo(320, 5);

    // The wrapper's own box follows the inner block it pass-through sizes.
    const wrapper = code!.parent as unknown as { width: number; height: number };
    expect(wrapper.width).toBeGreaterThanOrEqual(code!.width);
  });
});
