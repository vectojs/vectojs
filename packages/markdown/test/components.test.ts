// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Markdown } from '../src/Markdown';
import { RichText, Stack } from '@vectojs/ui';

// jsdom has no canvas getContext; measure.ts falls back to its estimate. Stub to
// keep the test output free of "Not implemented" noise.
HTMLCanvasElement.prototype.getContext = (() => null) as never;

describe('Markdown', () => {
  it('renders markdown headers and paragraphs into RichText', () => {
    const md = new Markdown('# Title\n\nSome text.', { maxWidth: 400 });
    expect(md.content.children.length).toBe(2);
    const heading = md.content.children[0] as RichText;
    expect(heading.spans.map((s) => s.text).join('')).toBe('Title');
    const para = md.content.children[1] as RichText;
    expect(para.spans.map((s) => s.text).join('')).toBe('Some text.');
  });

  it('renders code blocks and lists', () => {
    const md = new Markdown('```\nconst a = 1;\n```\n- item 1\n- item 2', { maxWidth: 400 });
    expect(md.content.children.length).toBe(2); // code block container, list

    // CodeBlock is a single leaf entity (no child sub-tree)
    const codeBlock = md.content.children[0];
    expect(codeBlock.children.length).toBe(0);

    const list = md.content.children[1] as Stack;
    expect(list.children.length).toBe(2);
    const firstItem = list.children[0] as RichText;
    expect(firstItem.spans.map((s) => s.text).join('')).toBe('• item 1');
  });
});
