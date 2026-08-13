// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { marked } from 'marked';
import { Markdown } from '../src/Markdown';

/**
 * `*[TERM]: definition` abbreviations (`markdown-it-abbr`'s syntax): every
 * later whole-word/-phrase occurrence of `TERM` in the document's prose gets
 * a dotted-underline treatment (`TextStyle.abbrTitle`), and the definition
 * line itself renders nothing (metadata, not content).
 *
 * ## Why this is architecturally unlike every other PX-0524 span construct
 *
 * `sub`/`sup`/`ins`/`mark`/`emoji` are all token-level substitutions: the
 * delimiters sit right at the use site, so the tokenizer alone decides the
 * style. An abbreviation's use site carries NO delimiters at all — `HTML` in
 * `The HTML spec` is an ordinary word until the document's dictionary is
 * known. So `markdown-abbr.ts` only collects `*[TERM]: definition` into a
 * `Map`; applying it to prose is `markdown-inline.ts`'s `emitProse`, which
 * every `collectSpans` leaf routes through.
 *
 * ## Why this needed a new tokenizer at all
 *
 * Nothing in `marked`'s grammar, including GFM, produces any token for
 * `*[TERM]: definition` — verified against marked@18.0.7 (`PX-0524`): a line
 * starting `*[` lexes as an ordinary paragraph (the `*` is not a valid list
 * marker without a following space, and `[TERM]` is not itself special at
 * block level). `markdown-abbr.ts` therefore registers its own `marked.use`
 * BLOCK extension (`ABBR_EXTENSIONS`), the same shape as
 * `markdown-footnote.ts`'s `footnoteDef` — single-line only, no `start()`.
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

/** The text of every span carrying `abbrTitle`, paired with its title. */
function abbrSpans(md: Markdown): Array<{ text: string; title: string }> {
  return allSpans(md)
    .filter((s) => typeof s.style?.abbrTitle === 'string')
    .map((s) => ({ text: s.text, title: s.style!.abbrTitle as string }));
}

describe('definition-line lexing (the upstream cause)', () => {
  it('marked produces no token for *[TERM]: definition at all without the extension', () => {
    // Pins the reason this needed a new tokenizer. If a future marked starts
    // lexing this shape itself, this changes and the extension may need
    // revisiting for a conflict.
    const tokens = marked.lexer('*[HTML]: HyperText Markup Language');
    // With the extension registered (module-level `marked.use` in
    // Markdown.ts), this now DOES produce an `abbrDef` token — asserted below
    // via the definition line rendering nothing.
    expect(tokens.length).toBeGreaterThan(0);
  });
});

describe('abbreviation definitions render nothing', () => {
  it('a lone definition produces no visible text', () => {
    const md = new Markdown('*[HTML]: HyperText Markup Language', { width: 600 });
    expect(projectedText(md)).toBe('');
  });

  it('a definition after prose leaves the prose visible and the definition invisible', () => {
    const md = new Markdown('The HTML spec is great.\n\n*[HTML]: HyperText Markup Language', {
      width: 600,
    });
    expect(projectedText(md)).toBe('The HTML spec is great.');
  });
});

describe('a defined term gets the dotted-underline treatment', () => {
  it('applies abbrTitle to a later whole-word occurrence', () => {
    const md = new Markdown('The HTML spec is great.\n\n*[HTML]: HyperText Markup Language', {
      width: 600,
    });
    const abbr = abbrSpans(md);
    expect(abbr).toEqual([{ text: 'HTML', title: 'HyperText Markup Language' }]);
  });

  it('applies to every occurrence in the document, not just the first', () => {
    const md = new Markdown('HTML is nice. I like HTML.\n\n*[HTML]: HyperText Markup Language', {
      width: 600,
    });
    expect(abbrSpans(md).map((s) => s.text)).toEqual(['HTML', 'HTML']);
  });

  it('does not require the definition to precede the use', () => {
    // GFM allows a definition anywhere; the dictionary is collected from the
    // whole token list before any prose is rendered.
    const md = new Markdown('*[HTML]: HyperText Markup Language\n\nThe HTML spec is great.', {
      width: 600,
    });
    expect(abbrSpans(md).map((s) => s.text)).toEqual(['HTML']);
  });

  it('is whole-word only: does not match inside a larger identifier', () => {
    const md = new Markdown('HTMLElement is not HTML.\n\n*[HTML]: HyperText Markup Language', {
      width: 600,
    });
    // Only the standalone "HTML" matches, not the "HTML" prefix of
    // "HTMLElement".
    expect(abbrSpans(md).map((s) => s.text)).toEqual(['HTML']);
    expect(projectedText(md)).toBe('HTMLElement is not HTML.');
  });

  it('supports a multi-word term', () => {
    const md = new Markdown(
      'Ask the JS Engine team.\n\n*[JS Engine]: JavaScript execution engine',
      { width: 600 },
    );
    expect(abbrSpans(md)).toEqual([{ text: 'JS Engine', title: 'JavaScript execution engine' }]);
  });

  it('a longer term wins over a shorter one at the same position', () => {
    const md = new Markdown(
      'HTML5 is not the same as HTML.\n\n*[HTML]: HyperText Markup Language\n*[HTML5]: HTML version 5',
      { width: 600 },
    );
    const abbr = abbrSpans(md);
    expect(abbr).toEqual([
      { text: 'HTML5', title: 'HTML version 5' },
      { text: 'HTML', title: 'HyperText Markup Language' },
    ]);
  });

  it('a later definition of the same term wins (last write wins)', () => {
    const md = new Markdown('The HTML spec.\n\n*[HTML]: First\n*[HTML]: Second', { width: 600 });
    expect(abbrSpans(md)).toEqual([{ text: 'HTML', title: 'Second' }]);
  });
});

describe('applies across every prose-emitting construct', () => {
  it('inside bold', () => {
    const md = new Markdown('**The HTML spec.**\n\n*[HTML]: def', { width: 600 });
    const abbr = abbrSpans(md);
    expect(abbr).toEqual([{ text: 'HTML', title: 'def' }]);
  });

  it('inside italic', () => {
    const md = new Markdown('*The HTML spec.*\n\n*[HTML]: def', { width: 600 });
    expect(abbrSpans(md)).toEqual([{ text: 'HTML', title: 'def' }]);
  });

  it('inside a heading', () => {
    const md = new Markdown('# The HTML spec\n\n*[HTML]: def', { width: 600 });
    expect(abbrSpans(md)).toEqual([{ text: 'HTML', title: 'def' }]);
  });

  it('inside a link label', () => {
    const md = new Markdown('[The HTML spec](https://example.com)\n\n*[HTML]: def', {
      width: 600,
    });
    const abbr = abbrSpans(md);
    expect(abbr).toEqual([{ text: 'HTML', title: 'def' }]);
    expect(abbr[0]).not.toHaveProperty('href');
  });

  it('inside a list item', () => {
    const md = new Markdown('- The HTML spec\n\n*[HTML]: def', { width: 600 });
    expect(abbrSpans(md)).toEqual([{ text: 'HTML', title: 'def' }]);
  });

  it('inside a table cell', () => {
    const md = new Markdown('| Spec |\n| --- |\n| HTML |\n\n*[HTML]: def', { width: 600 });
    expect(abbrSpans(md)).toEqual([{ text: 'HTML', title: 'def' }]);
  });

  it('NOT inside inline code', () => {
    const md = new Markdown('`HTML` is not styled here.\n\n*[HTML]: def', { width: 600 });
    expect(abbrSpans(md)).toEqual([]);
    expect(projectedText(md)).toBe('HTML is not styled here.');
  });
});

describe('an undefined document has no abbreviation cost', () => {
  it('a document with no definitions produces no abbrTitle spans', () => {
    const md = new Markdown('The HTML spec is great.', { width: 600 });
    expect(abbrSpans(md)).toEqual([]);
    expect(projectedText(md)).toBe('The HTML spec is great.');
  });
});

describe('a definition arriving late re-styles already-rendered prose', () => {
  it('a streamed definition after its term has already rendered applies retroactively', () => {
    // `appendMarkdown` is the INCREMENTAL path — `setContent` full-rebuilds and
    // never reaches `updateTokens`, so a test written against `setContent` cannot
    // observe a stale-reuse regression at all (see `footnotes.test.ts`'s identical
    // note). The `HTML` paragraph's own `raw` is untouched by the append below —
    // only a new trailing block is added — so without `Markdown.ts`'s
    // `abbreviationsChanged` guard capping `matchLen` to 0, `updateTokens` would
    // reuse the paragraph's existing (unstyled) entity via its `setSpans` in-place
    // path and the dictionary would never reach it.
    const md = new Markdown('The HTML spec is great.\n\n', { width: 600 });
    expect(abbrSpans(md)).toEqual([]);
    md.appendMarkdown('*[HTML]: HyperText Markup Language');
    expect(abbrSpans(md)).toEqual([{ text: 'HTML', title: 'HyperText Markup Language' }]);
  });

  it('restyles prose in a single-block document too', () => {
    // A document that is ONE token hits the reconciler's single-block case:
    // `abbreviationsChanged` caps `matchLen` to 0, and
    // `0 === oldTokens.length - 1` holds, so the blockquote in-place branch
    // fired with the new dictionary already installed and only the quote's
    // TAIL child was restyled — the earlier inner paragraph kept spans built
    // before the definition existed. Gating the in-place branches on
    // `abbreviationsChanged` forces the full rebuild the cap was promising,
    // which is what makes the streamed document match a one-shot build of the
    // combined text. The two inner paragraphs matter: one paragraph spanning
    // both lines is itself the tail, so its restyle would mask the bug.
    const streamed = new Markdown('> HTML is fun\n>\n> more', { width: 600 });
    streamed.appendMarkdown('\n\n*[HTML]: HyperText');
    const oneShot = new Markdown('> HTML is fun\n>\n> more\n\n*[HTML]: HyperText', {
      width: 600,
    });
    expect(abbrSpans(streamed)).toEqual(abbrSpans(oneShot));
    expect(abbrSpans(streamed).map((s) => s.text)).toEqual(['HTML']);
  });
});
