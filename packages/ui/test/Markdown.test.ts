// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { Markdown } from '../src/Markdown';

// Minimal renderer mock
function mockRenderer() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    rotate: vi.fn(),
    setGlobalAlpha: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    bezierCurveTo: vi.fn(),
    closePath: vi.fn(),
    arc: vi.fn(),
    roundRect: vi.fn(),
    drawImage: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillText: vi.fn(),
    fillCircle: vi.fn(),
    clip: vi.fn(),
    flush: vi.fn(),
    createLinearGradient: vi.fn(() => ({})),
  };
}

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
    // The code block should be a container with children (bg + lines)
    const codeBlock = md.content.children[0];
    expect(codeBlock.children.length).toBeGreaterThanOrEqual(1);
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

  it('renders blockquotes with border', () => {
    const md = new Markdown('> This is a quote');
    expect(md.content.children.length).toBeGreaterThanOrEqual(1);
    const bq = md.content.children[0];
    expect(bq.children.length).toBeGreaterThanOrEqual(1);
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
});
