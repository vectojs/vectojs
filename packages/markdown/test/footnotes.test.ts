// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { RichText } from '@vectojs/ui';
import { marked, type Tokens } from 'marked';
import { Markdown } from '../src/Markdown';
import { footnoteMarker } from '../src/markdown-footnote';
import { DEFAULT_THEME, resolveTheme } from '../src/theme';

/**
 * GFM footnotes: `[^1]` inline and `[^1]: note` as a block.
 *
 * ## What the defect was, and why one test is not enough
 *
 * Before this, footnote lexing split on **whether the note body contains a
 * space**, because marked's link-reference-definition rule claims the line and a
 * link destination cannot contain an unescaped space. Measured against
 * marked@18.0.7:
 *
 * | Source                | Lexed to                      | Reader saw                     |
 * | --------------------- | ----------------------------- | ------------------------------ |
 * | `[^1]: The note.`     | `paragraph, space, paragraph` | raw `Here[^1]` + stray block   |
 * | `[^1]: Note.`         | `paragraph, space, def`       | **a link to `Note.`**, def gone |
 *
 * The single-word case is strictly worse — a live link to a garbage URL plus
 * silently dropped content — so it gets its own assertions throughout. A suite
 * written only against the multi-word form passes while that case still ships.
 *
 * Importing `../src/Markdown` is what registers the extensions on the shared
 * `marked` singleton, which is why the lexer assertions below can call
 * `marked.lexer` directly.
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

/** Each top-level block's text, or `<EntityName>` for a non-text block. */
function blockTexts(md: Markdown): string[] {
  return md.content.children.map((child) => {
    const spans = (child as RichText).spans;
    return spans ? spans.map((s) => s.text).join('') : `<${child.constructor.name}>`;
  });
}

const MULTI = 'Here[^1] is text.\n\n[^1]: The note.\n';
const SINGLE = 'Here[^1] is text.\n\n[^1]: Note.\n';

describe('footnote lexing', () => {
  it('lexes a multi-word definition as a footnoteDef, not a stray paragraph', () => {
    const tokens = marked.lexer(MULTI);
    expect(tokens.map((t) => t.type)).toEqual(['paragraph', 'space', 'footnoteDef']);
    const def = tokens[2] as unknown as { label: string; body: string };
    expect(def.label).toBe('1');
    expect(def.body).toBe('The note.');
  });

  it('lexes a SINGLE-WORD definition identically — the worse case', () => {
    // Baseline behaviour was `[paragraph, space, def]` with the reference becoming
    // an inline `link` to `href: 'Note.'`. Both halves are asserted: the block
    // shape here, the absence of the link below.
    const tokens = marked.lexer(SINGLE);
    expect(tokens.map((t) => t.type)).toEqual(['paragraph', 'space', 'footnoteDef']);
    const def = tokens[2] as unknown as { label: string; body: string };
    expect(def.label).toBe('1');
    expect(def.body).toBe('Note.');
  });

  it('never produces a link token for a footnote reference', () => {
    for (const src of [MULTI, SINGLE, 'A[^note] b.\n\n[^note]: Named.\n']) {
      const paragraph = marked.lexer(src)[0] as Tokens.Paragraph;
      const kinds = paragraph.tokens.map((t) => t.type);
      expect(kinds, src).toContain('footnoteRef');
      expect(kinds, src).not.toContain('link');
    }
  });

  it('leaves tokens.links empty, so a footnote cannot degrade incremental lexing', () => {
    // The baseline populated `links` for the single-word case, and
    // `incrementalLex.ts` degrades an instance PERMANENTLY on any link definition.
    // Claiming the definition line ahead of the built-in `def` rule is what avoids
    // that; this pins the side effect so it cannot regress silently.
    for (const src of [MULTI, SINGLE]) {
      expect(Object.keys((marked.lexer(src) as unknown as { links: object }).links), src).toEqual(
        [],
      );
    }
  });

  it('still lexes a real link reference definition', () => {
    // The control. Without it, every assertion above would keep passing if the
    // footnote tokenizer swallowed ALL bracket-colon lines.
    const tokens = marked.lexer('A [ref] here.\n\n[ref]: https://e.test\n');
    expect(tokens.map((t) => t.type)).toEqual(['paragraph', 'space', 'def']);
    expect(Object.keys((tokens as unknown as { links: object }).links)).toEqual(['ref']);
    const paragraph = tokens[0] as Tokens.Paragraph;
    expect(paragraph.tokens.map((t) => t.type)).toContain('link');
  });

  it('still lexes an ordinary inline link', () => {
    const paragraph = marked.lexer('A [link](https://e.test) here.\n')[0] as Tokens.Paragraph;
    const link = paragraph.tokens.find((t) => t.type === 'link') as Tokens.Link | undefined;
    expect(link?.href).toBe('https://e.test');
  });

  it('does not claim an escaped reference', () => {
    const paragraph = marked.lexer('Not a \\[^1] ref.\n')[0] as Tokens.Paragraph;
    expect(paragraph.tokens.map((t) => t.type)).not.toContain('footnoteRef');
  });

  it('claims a reference in every nesting context', () => {
    // A reference is inline, so it can appear anywhere inline tokens are lexed.
    // A per-context check because each of these reaches `collectSpans` by a
    // different route, and a missed one renders the marker as literal text.
    const cases: Array<[string, string]> = [
      ['heading', '# Title[^1]\n'],
      ['list item', '- item[^1]\n'],
      ['blockquote', '> quoted[^1]\n'],
      ['table cell', '| a[^1] |\n| --- |\n| b |\n'],
    ];
    for (const [name, src] of cases) {
      expect(JSON.stringify(marked.lexer(src)), name).toContain('footnoteRef');
    }
  });

  it('tiles the source with its raw strings', () => {
    // The invariant every incremental offset is derived from — `incrementalLex.ts`
    // sums `raw` lengths. A block extension supplying `start()` breaks it by
    // inserting a newline the source does not contain, which is why neither
    // extension supplies one.
    for (const src of [
      MULTI,
      SINGLE,
      '[^1]: Dangling.\n',
      'A[^1] B[^2].\n\n[^1]: One.\n[^2]: Two.\n',
      '# T[^1]\n\npara[^2] x\n\n[^1]: a\n[^2]: b\n',
    ]) {
      expect(
        marked
          .lexer(src)
          .map((t) => t.raw)
          .join(''),
        src,
      ).toBe(src);
    }
  });

  it('does not re-group paragraphs that precede it', () => {
    // A block extension with `start()` retroactively merges already-emitted
    // paragraphs: measured, this exact source lost its `Term` paragraph, 4 content
    // tokens collapsing to 3. Asserted against the no-footnote baseline rather
    // than a literal, so it states the actual requirement — that appending a
    // definition changes nothing about what came before.
    const prose = 'Term\n: definition-ish\n| partial | table |\n| --- |\n\nAfter.\n';
    const before = marked.lexer(prose).map((t) => t.type);
    const after = marked.lexer(`${prose}\n[^1]: n\n`).map((t) => t.type);
    expect(after.slice(0, before.length)).toEqual(before);
  });
});

describe('footnote rendering', () => {
  it('renders the reference as a small tinted marker, not raw syntax', () => {
    const md = new Markdown(MULTI, { maxWidth: 600 });
    const text = projectedText(md);
    expect(text).toContain('[1]');
    // The raw syntax is what the reader used to see for the multi-word case.
    expect(text).not.toContain('[^1]');

    const marker = allSpans(md).find((s) => s.text === '[1]');
    expect(marker).toBeDefined();
    expect(marker?.style?.color).toBe(DEFAULT_THEME.footnoteColor);
    expect(marker?.style?.fontSize).toBeCloseTo(
      DEFAULT_THEME.fontSize * DEFAULT_THEME.footnoteMarkerScale,
    );
  });

  it('gives the marker no href, so it is not a link', () => {
    // The single-word case rendered a REAL clickable link to `Note.`. A marker
    // must carry no destination at all: it refers to a sibling block, not a URL.
    for (const src of [MULTI, SINGLE]) {
      const marker = allSpans(new Markdown(src, { maxWidth: 600 })).find((s) => s.text === '[1]');
      expect(marker, src).toBeDefined();
      expect(marker?.style?.href, src).toBeUndefined();
    }
  });

  it('renders the definition as its own block, for both body shapes', () => {
    for (const [src, body] of [
      [MULTI, 'The note.'],
      [SINGLE, 'Note.'],
    ]) {
      const md = new Markdown(src, { maxWidth: 600 });
      // paragraph + definition. The `space` token renders nothing.
      expect(md.content.children.length, src).toBe(2);
      const def = md.content.children[1] as RichText;
      expect(def, src).toBeInstanceOf(RichText);
      const text = def.spans.map((s) => s.text).join('');
      expect(text, src).toContain('[1]');
      expect(text, src).toContain(body);
    }
  });

  it('does not drop the definition of a single-word note', () => {
    // The baseline lexed this to a `def`, which renders nothing — the note
    // vanished from the document entirely.
    expect(projectedText(new Markdown(SINGLE, { maxWidth: 600 }))).toContain('Note.');
  });

  it('tints the definition label but not its body', () => {
    const md = new Markdown(MULTI, { maxWidth: 600 });
    const def = md.content.children[1] as RichText;
    const label = def.spans.find((s) => s.text === '[1]');
    const body = def.spans.find((s) => s.text === 'The note.');
    expect(label?.style?.color).toBe(DEFAULT_THEME.footnoteColor);
    expect(body?.style?.color).toBeUndefined();
  });

  it('renders a definition that no reference points at', () => {
    const md = new Markdown('[^orphan]: Nobody cites me.\n', { maxWidth: 600 });
    expect(md.content.children.length).toBe(1);
    expect(projectedText(md)).toContain('Nobody cites me.');
  });

  it('renders a reference that has no definition', () => {
    // Deliberate: a reference is claimed unconditionally rather than checked
    // against a definition table, so a streamed document renders its marker before
    // the definition arrives. incremark patches micromark for the same reason.
    expect(projectedText(new Markdown('Orphan[^9] ref.\n', { maxWidth: 600 }))).toContain('[9]');
  });

  it('renders a named label as written, without renumbering', () => {
    // Not GFM's 1,2,3-by-first-reference. Renumbering needs document-wide state,
    // which is the non-local dependency that makes incremental lexing unsound.
    const md = new Markdown('A[^note] b.\n\n[^note]: Named.\n', {
      maxWidth: 600,
    });
    expect(projectedText(md)).toContain('[note]');
  });

  it('scales the marker with the run it sits in', () => {
    // A heading's size lives in its `font` string, not in any span style, so this
    // is what proves `blockFontSize` reaches the arm.
    const md = new Markdown('# Title[^1]\n', { maxWidth: 600 });
    const marker = allSpans(md).find((s) => s.text === '[1]');
    const h1 = DEFAULT_THEME.headingSizes[0];
    expect(marker?.style?.fontSize).toBeCloseTo(h1 * DEFAULT_THEME.footnoteMarkerScale);
    // And is therefore larger than a body-prose marker would be.
    expect(marker?.style?.fontSize as number).toBeGreaterThan(
      DEFAULT_THEME.fontSize * DEFAULT_THEME.footnoteMarkerScale,
    );
  });

  it('reflows a definition to a new width', () => {
    // `reflowToken`'s `default:` arm handles only `Text`, and a definition is a
    // `RichText` — without its own arm a resized definition keeps its old width
    // forever, silently.
    const md = new Markdown(MULTI, { maxWidth: 600 });
    const def = md.content.children[1] as RichText;
    expect(def.maxWidth).toBe(600);
    md.setMaxWidth(300);
    expect(md.content.children[1]).toBe(def);
    expect(def.maxWidth).toBe(300);
  });

  it('keeps token and entity indices aligned across a definition', () => {
    // `producesEntity` maps token indices to child indices, and a null-rendering
    // block before a growing tail shifts every subsequent child by one — updating
    // or destroying the wrong entity. A definition between two paragraphs is the
    // arrangement that exposes a parity error.
    const md = new Markdown('One.\n\n[^1]: note one\n\nTwo.\n', {
      maxWidth: 600,
    });
    const texts = md.content.children.map((c) =>
      ((c as RichText).spans ?? []).map((s) => s.text).join(''),
    );
    expect(texts.length).toBe(3);
    expect(texts[0]).toBe('One.');
    expect(texts[1]).toContain('note one');
    expect(texts[2]).toBe('Two.');
  });
});

describe('footnote theming', () => {
  it('derives footnoteColor from linkColor', () => {
    expect(resolveTheme({ linkColor: '#abcdef' }).footnoteColor).toBe('#abcdef');
  });

  it('lets footnoteColor be set independently of linkColor', () => {
    const theme = resolveTheme({
      linkColor: '#abcdef',
      footnoteColor: '#123456',
    });
    expect(theme.footnoteColor).toBe('#123456');
    expect(theme.linkColor).toBe('#abcdef');
  });

  it('applies an overridden footnoteColor to both marker and label', () => {
    const md = new Markdown(MULTI, {
      maxWidth: 600,
      theme: { footnoteColor: '#ff0000' },
    });
    const tinted = allSpans(md).filter((s) => s.style?.color === '#ff0000');
    // One marker in the paragraph, one label on the definition.
    expect(tinted.length).toBe(2);
  });

  it('honours footnoteMarkerScale', () => {
    const md = new Markdown(MULTI, {
      maxWidth: 600,
      theme: { footnoteMarkerScale: 0.5 },
    });
    const marker = allSpans(md).find((s) => s.text === '[1]');
    expect(marker?.style?.fontSize).toBeCloseTo(DEFAULT_THEME.fontSize * 0.5);
  });
});

describe('footnoteMarker', () => {
  it('drops the caret and brackets the label', () => {
    expect(footnoteMarker('1')).toBe('[1]');
    expect(footnoteMarker('note')).toBe('[note]');
  });
});

describe('footnote streaming', () => {
  it('reaches the same tree whether written at once or appended', () => {
    // The property that matters for a streamed document: the incremental path must
    // converge on what a full parse produces.
    const whole = new Markdown(MULTI, { maxWidth: 600 });
    const streamed = new Markdown('Here[^1] is text.\n', { maxWidth: 600 });
    streamed.setContent(MULTI);
    expect(projectedText(streamed)).toBe(projectedText(whole));
  });

  it('renders the marker before the definition has arrived', () => {
    const md = new Markdown('Here[^1] is te', { maxWidth: 600 });
    expect(projectedText(md)).toContain('[1]');
  });

  it('keeps a definition intact when the tail grows past it', () => {
    // `appendMarkdown` is the incremental path — `setContent` full-rebuilds and
    // never reaches `updateTokens`, so a test written against it cannot observe a
    // child-index parity error at all. Measured: every `streamStats` counter is 0
    // after a `setContent`.
    //
    // With `producesEntity`'s `footnoteDef` arm removed, this exact sequence
    // renders `A. | B. more | B` — the definition OVERWRITTEN by the tail and a
    // stale duplicate left behind.
    const md = new Markdown('A.\n\n[^1]: note\n\nB', { maxWidth: 600 });
    md.appendMarkdown('. more');
    expect(blockTexts(md)).toEqual(['A.', '[1] note', 'B. more']);
  });

  it('keeps a definition intact when a whole block is appended after it', () => {
    // Sabotaged, this renders `A. | Tail grows | [1] note | Tail`: four children
    // for three blocks, the definition displaced and a stale copy of the tail
    // stranded behind it.
    const md = new Markdown('A.\n\n', { maxWidth: 600 });
    md.appendMarkdown('[^1]: note\n');
    md.appendMarkdown('\nTail');
    md.appendMarkdown(' grows');
    expect(blockTexts(md)).toEqual(['A.', '[1] note', 'Tail grows']);
  });

  it('keeps two consecutive definitions distinct as a block is appended', () => {
    // Sabotaged: `A. | [1] one | [2] two | [2] two | B.` — the second definition
    // duplicated.
    const md = new Markdown('A.\n\n[^1]: one\n', { maxWidth: 600 });
    md.appendMarkdown('[^2]: two\n');
    md.appendMarkdown('\nB.');
    expect(blockTexts(md)).toEqual(['A.', '[1] one', '[2] two', 'B.']);
  });

  it('destroys the right entity when a definition precedes the growing tail', () => {
    // This is the arrangement `producesEntity`'s docblock warns about, and the one
    // fresh construction cannot exercise: `setTokens` builds a token-index ->
    // child-index prefix sum from `producesEntity`, and `updateTokens` uses it to
    // pick which child to `destroy()`. If a definition's entry is wrong, the
    // rebuild destroys a DIFFERENT block than the one whose token changed.
    //
    // So the definition has to sit before a tail that keeps growing across several
    // appends, with a distinct block on either side of it.
    const md = new Markdown('Alpha.\n\n[^1]: note one\n\nBeta.\n', { maxWidth: 600 });
    for (const chunk of [
      'Alpha.\n\n[^1]: note one\n\nBeta. more',
      'Alpha.\n\n[^1]: note one\n\nBeta. more text',
    ]) {
      md.setContent(chunk);
    }
    const texts = md.content.children.map((c) =>
      ((c as RichText).spans ?? []).map((s) => s.text).join(''),
    );
    // All three blocks still present, in order, none clobbered by its neighbour.
    expect(texts.length).toBe(3);
    expect(texts[0]).toBe('Alpha.');
    expect(texts[1]).toContain('note one');
    expect(texts[2]).toBe('Beta. more text');
  });
});
