import { describe, expect, it } from 'vitest';
import { parseFrontMatterFields, scanFrontMatter } from '../src/frontMatter';

/**
 * Scanner-level tests. The document-level behaviour these produce (and the
 * streaming hold) is covered in `frontMatterDocument.test.ts`.
 */
describe('scanFrontMatter', () => {
  it('finds a block and reports the body offset', () => {
    const scan = scanFrontMatter('---\ntitle: A\n---\n# Body', true);
    expect(scan).toEqual({ kind: 'found', raw: 'title: A\n', bodyStart: 17 });
  });

  it('accepts YAML document terminator `...` as the closing delimiter', () => {
    const scan = scanFrontMatter('---\ntitle: A\n...\n# Body', true);
    expect(scan.kind).toBe('found');
  });

  it('handles CRLF line endings', () => {
    const scan = scanFrontMatter('---\r\ntitle: A\r\n---\r\n# Body', true);
    // `raw` keeps the document's own line endings; only the delimiter match is
    // newline-agnostic.
    expect(scan).toEqual({ kind: 'found', raw: 'title: A\r\n', bodyStart: 20 });
  });

  it('reads a block that ends the document, leaving an empty body', () => {
    const scan = scanFrontMatter('---\ntitle: A\n---', true);
    // bodyStart is the text length, not one past it: a closer with no trailing
    // newline means there is no body, and slicing past the end would be a bug
    // that only shows up as a stray character on the next append.
    expect(scan).toEqual({ kind: 'found', raw: 'title: A\n', bodyStart: 16 });
  });

  it('holds a closer that sits on an unterminated line mid-stream', () => {
    // The same text as above, but a stream could still extend `---` to `----`,
    // which is a thematic break rather than a closer. `Markdown.initSource`
    // re-scans a whole document with `complete: true` for exactly this case.
    expect(scanFrontMatter('---\ntitle: A\n---', false).kind).toBe('pending');
  });

  describe('rejects a leading thematic break', () => {
    // Each of these opens with `---` and must NOT be eaten as metadata. This is
    // the whole risk of stripping front matter: a false positive silently
    // deletes the top of someone's document.
    const notFrontMatter: Record<string, string> = {
      'blank line after the opener': '---\n\n# Title\n\n---\n\nmore',
      'a heading, not a key': '---\n# Title\n---',
      'four dashes is a break, not an opener': '----\nkey: v\n----',
      'a YAML sequence, not a mapping': '---\n- a\n---',
      'no colon-space, so not a mapping entry': '---\nkey:value\n---',
      'not at the start of the document': 'x\n---\ntitle: A\n---',
      'a list item': '- item',
      'ordinary content': '# Body',
    };
    for (const [name, src] of Object.entries(notFrontMatter)) {
      it(name, () => {
        expect(scanFrontMatter(src, true).kind).toBe('none');
        // Also 'none' mid-stream: these are decided by text already in hand, so
        // waiting for more would hold a document back for nothing.
        expect(scanFrontMatter(src, false).kind).toBe('none');
      });
    }
  });

  describe('mid-stream undecidability', () => {
    // A prefix that could still become an opener must be held, or the document
    // paints a thematic break that the next chunk has to tear down.
    for (const prefix of ['-', '--', '---', '---\n', '---\ntitle: A']) {
      it(`holds ${JSON.stringify(prefix)} while more text may arrive`, () => {
        expect(scanFrontMatter(prefix, false).kind).toBe('pending');
        // The same text with nothing more coming is content, which is exactly
        // what marked produced before this stripping existed.
        expect(scanFrontMatter(prefix, true).kind).toBe('none');
      });
    }

    it('holds `---\\n---`, which could still grow a key', () => {
      // Complete, this is two thematic breaks — the second `---` is not a key, so
      // it is not an empty front matter block. Mid-stream it must still be held:
      // the line could grow into `---: v`, which is one.
      expect(scanFrontMatter('---\n---', true).kind).toBe('none');
      expect(scanFrontMatter('---\n---', false).kind).toBe('pending');
    });

    it('holds the empty document even when told it is complete', () => {
      // Load-bearing: `new Markdown('')` + appendMarkdown is the streaming API,
      // so settling this against an empty string would make front matter in the
      // first appended chunk unrecognisable.
      expect(scanFrontMatter('', true).kind).toBe('pending');
    });

    it('gives up on an unterminated block past the hold budget', () => {
      // An opener with no closer holds back the ENTIRE document, so the wait has
      // to be bounded — otherwise a thematic break at the top of a long document
      // renders nothing at all.
      const long = `---\ntitle: A\n${'x: y\n'.repeat(1200)}`;
      expect(long.length).toBeGreaterThan(4096);
      expect(scanFrontMatter(long, false).kind).toBe('none');
    });
  });
});

describe('parseFrontMatterFields', () => {
  it('reads top-level scalars, stripping one pair of quotes', () => {
    expect(
      parseFrontMatterFields('title: "Hello"\nsub: \'World\'\ndate: 2026-08-03\ntags: a, b\n'),
    ).toEqual({
      title: 'Hello',
      sub: 'World',
      date: '2026-08-03',
      tags: 'a, b',
    });
  });

  it('skips comments and the indented children of a structure', () => {
    const fields = parseFrontMatterFields(
      '# a comment\nnest:\n  inner: 1\nlist:\n  - x\nkept: yes\n',
    );
    // `inner` must not surface as a top-level key. `nest` and `list` themselves
    // are present with an empty value: a key with no inline value is
    // indistinguishable from YAML's null scalar without parsing its children,
    // and this function deliberately does not.
    expect(fields).toEqual({ nest: '', list: '', kept: 'yes' });
  });

  it('does not mistake a URL for a key', () => {
    // YAML requires whitespace after a mapping key's colon; without it this is a
    // value, not an entry. Getting this wrong turns `url: http://x` into a key
    // named `url: http`.
    expect(parseFrontMatterFields('url: http://x\nhttp://y\n')).toEqual({
      url: 'http://x',
    });
  });

  it('keeps a `#` inside a value', () => {
    // Stripping a trailing comment would corrupt colours and URL fragments.
    expect(parseFrontMatterFields('color: #ff0000\n')).toEqual({
      color: '#ff0000',
    });
  });

  it('keeps the last of a repeated key, as YAML does', () => {
    expect(parseFrontMatterFields('k: 1\nk: 2\n')).toEqual({ k: '2' });
  });

  it('returns an empty object for no front matter', () => {
    expect(parseFrontMatterFields('')).toEqual({});
  });
});
