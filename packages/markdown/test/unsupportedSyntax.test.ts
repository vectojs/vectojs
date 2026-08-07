// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Markdown } from '../src/Markdown';

/**
 * Two constructs this renderer deliberately does not support, pinned so the
 * behaviour is a decision rather than an accident.
 *
 * Neither is a feature and neither is going to be one soon. What was missing was
 * any record of that: both were measured in a 2026-08-06 audit, neither was
 * documented, and neither was tested — so a future change could alter either one
 * in any direction without anything noticing. See
 * `forge/decisions/markdown-syntax-coverage-2026-08.md`.
 *
 * ## Definition lists
 *
 * `Term\n: definition` is not CommonMark and not GFM. `marked` lexes it as one
 * paragraph whose text keeps the newline, so it renders as two lines with a
 * visible leading colon — the literal source, which is the honest rendering of
 * syntax the parser does not recognize. Its natural fix is the same syntax-
 * extension mechanism footnotes need, so it belongs behind that work.
 *
 * ## Raw HTML blocks
 *
 * A `<details>`, `<div>` or `<iframe>` block renders nothing. This is structural,
 * not an oversight: there is no DOM to hand markup to. `<svg>` is the one
 * exception, because a self-contained SVG document can be rasterized, and
 * `producesEntity` gates on the text containing both `<svg` and `</svg>`.
 *
 * Note which token shape reaches that gate. Measured against marked@18: a
 * MULTI-LINE svg lexes to a block `html` token, while a single-line
 * `<svg …></svg>` lexes to a PARAGRAPH of inline `html` tokens. The real document
 * form — an svg surrounded by blank lines — is the multi-line one.
 */

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

/** How many blocks the document rendered. */
function blockCount(md: Markdown): number {
  const content = (md as unknown as { content: { children: unknown[] } }).content;
  return content.children.length;
}

describe('deliberately unsupported: definition lists', () => {
  it('renders the literal source rather than a definition list', () => {
    const md = new Markdown('Term\n: definition', { width: 600 });
    // One paragraph, not a term/definition pair. The colon is visible because it
    // is a literal character in a paragraph this parser does not treat as syntax.
    expect(blockCount(md)).toBe(1);
    expect(projectedText(md)).toContain(': definition');
  });
});

describe('deliberately unsupported: raw HTML blocks', () => {
  it('renders nothing for a details block', () => {
    const md = new Markdown('<details>\n<summary>s</summary>\nbody\n</details>', { width: 600 });
    expect(blockCount(md)).toBe(0);
  });

  it('renders nothing for a div block', () => {
    expect(blockCount(new Markdown('<div class="x">content</div>', { width: 600 }))).toBe(0);
  });

  it('renders nothing for an iframe block', () => {
    // Also the security-relevant case: an iframe must never be materialized from
    // document text.
    expect(blockCount(new Markdown('<iframe src="https://e.test"></iframe>', { width: 600 }))).toBe(
      0,
    );
  });

  it('renders nothing for an HTML comment', () => {
    expect(blockCount(new Markdown('<!-- a comment -->', { width: 600 }))).toBe(0);
  });

  it('still renders a multi-line SVG block, which is the one exception', () => {
    // The control. Without it, the four assertions above would keep passing if the
    // whole `html` arm were deleted.
    const md = new Markdown('<svg viewBox="0 0 10 10">\n  <rect width="10" height="10"/>\n</svg>', {
      width: 600,
    });
    expect(blockCount(md)).toBe(1);
  });

  it('does not print raw tags as visible text in a paragraph', () => {
    // The inline `html` arm drops tags rather than painting them. `<br>` is the one
    // tag with an inline-text meaning and becomes a newline.
    const md = new Markdown('a <span>b</span> c', { width: 600 });
    const text = projectedText(md);
    expect(text).not.toContain('<span>');
    expect(text).toContain('b');
  });
});
