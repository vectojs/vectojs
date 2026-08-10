// @vitest-environment jsdom
/**
 * Multi-line syntax constructs: block comments, template literals, docstrings.
 *
 * The highlighter used to tokenize each line in isolation, which is correct for
 * everything that ends at a newline and wrong for everything that does not. A
 * `/*` comment coloured its first line and left every following line painted as
 * live code — so the *more* a document commented, the more of it was mis-coloured.
 * It also forced CSS to declare no comment support at all, since CSS has no line
 * comment form to fall back on.
 *
 * `highlightLine` now takes and returns a `CarryState`, and `CodeBlock` records
 * the state entering each line so streaming prefix-reuse still works. These tests
 * pin both halves: the colouring across lines, and the invariant that segment
 * text always reproduces the source exactly.
 */
import { describe, expect, it } from 'vitest';
import { CodeBlock, Markdown } from '../src/Markdown';

const KEYWORD = '#c084fc';
const STRING = '#86efac';
const COMMENT = '#64748b';
const CODE = '#a5f3fc';
const NUMBER = '#fbbf24';

interface Seg {
  text: string;
  color: string;
}

/** The private highlight output, per row. */
function rows(source: string, lang: string): Seg[][] {
  const md = new Markdown('```' + lang + '\n' + source + '\n```');
  const cb = md.content.children[0] as unknown as { lines: Seg[][] };
  return cb.lines;
}

/** `text=color` pairs for one row. */
function segs(source: string, lang: string, row: number): string[] {
  return rows(source, lang)[row].map((s) => `${s.text}=${s.color}`);
}

/** Distinct colors present on a row, for asserting "all one color". */
function colorsOf(source: string, lang: string, row: number): string[] {
  return [...new Set(rows(source, lang)[row].map((s) => s.color))];
}

describe('CodeBlock multi-line syntax constructs', () => {
  describe('block comments', () => {
    // The core defect: line 2 of a block comment was painted as code, and any
    // keyword inside it was coloured as a live keyword.
    it('keeps a C block comment coloured across every line it spans', () => {
      const src = ['/* opening', ' * return class function', ' */', 'const x = 1;'].join('\n');
      expect(colorsOf(src, 'ts', 0)).toEqual([COMMENT]);
      expect(colorsOf(src, 'ts', 1)).toEqual([COMMENT]);
      expect(colorsOf(src, 'ts', 2)).toEqual([COMMENT]);
      // And it must STOP: the line after the close is live code again.
      expect(segs(src, 'ts', 3)).toContain(`const=${KEYWORD}`);
    });

    it('does not treat a keyword inside a block comment as a keyword', () => {
      const src = ['/*', 'const let function class', '*/'].join('\n');
      expect(colorsOf(src, 'ts', 1)).toEqual([COMMENT]);
    });

    it('gives CSS working comments, which it previously could not have', () => {
      // CSS has no line-comment form, so before block comments existed CSS
      // declared `lineComments: []` and a comment was simply uncoloured.
      const src = ['/* palette', '   brand tokens */', '.a { color: red; }'].join('\n');
      expect(colorsOf(src, 'css', 0)).toEqual([COMMENT]);
      expect(colorsOf(src, 'css', 1)).toEqual([COMMENT]);
      expect(colorsOf(src, 'css', 2)).not.toEqual([COMMENT]);
    });

    it('closes a block comment mid-line and highlights the code after it', () => {
      const src = ['/* note */ const x = 1;'].join('\n');
      const line = segs(src, 'ts', 0);
      expect(line).toContain(`/* note */=${COMMENT}`);
      expect(line).toContain(`const=${KEYWORD}`);
    });

    it('prefers a line comment over a block comment when both could match', () => {
      // `//` and `/*` share a first character; the exact prefix decides. A `//`
      // line must NOT carry state to the next line.
      const src = ['// just a line', 'const x = 1;'].join('\n');
      expect(colorsOf(src, 'ts', 0)).toEqual([COMMENT]);
      expect(segs(src, 'ts', 1)).toContain(`const=${KEYWORD}`);
    });

    it('leaves a language without block comments unaffected', () => {
      // bash has no `/* */`. The sequence is ordinary text, and must not open a
      // comment that swallows the rest of the block.
      const src = ['echo "/*"', 'echo hi'].join('\n');
      expect(colorsOf(src, 'bash', 1)).not.toEqual([COMMENT]);
    });
  });

  describe('multi-line strings', () => {
    it('carries a JS template literal across lines', () => {
      const src = ['const t = `line one', 'still string return', '`;'].join('\n');
      expect(segs(src, 'ts', 0)).toContain(`const=${KEYWORD}`);
      expect(colorsOf(src, 'ts', 1)).toEqual([STRING]);
    });

    it('carries a Python triple-quoted docstring across lines', () => {
      const src = [
        'def f():',
        '    """Docstring',
        '    def class return',
        '    """',
        '    pass',
      ].join('\n');
      expect(segs(src, 'py', 0)).toContain(`def=${KEYWORD}`);
      expect(colorsOf(src, 'py', 2)).toEqual([STRING]);
      // `pass` after the docstring closes is a live keyword again.
      expect(segs(src, 'py', 4)).toContain(`pass=${KEYWORD}`);
    });

    it("prefers Python's ''' over ' so a docstring is not a one-char string", () => {
      const src = ["'''doc", 'body', "'''"].join('\n');
      expect(colorsOf(src, 'py', 1)).toEqual([STRING]);
    });

    it('still refuses to carry a plain quote, so a Rust lifetime is safe', () => {
      // The single-line `quotes` rule requires a close on the same line. That
      // guard is what keeps `&'a str` from painting the rest of the file green,
      // and it must survive the new carry machinery.
      const src = ["fn f<'a>(s: &'a str) -> &'a str {", '    s', '}'].join('\n');
      expect(colorsOf(src, 'rust', 1)).not.toEqual([STRING]);
    });
  });

  describe('invariants', () => {
    // The highlighter is a colouring pass over the source, so losing or
    // duplicating a character here would desynchronise the painted cells from
    // the content grid, which indexes by source offset.
    it('reproduces the source exactly, line for line', () => {
      const src = [
        '/* block',
        ' * with `backticks` and "quotes"',
        ' */',
        'const t = `tpl',
        'more ${x} text',
        '`;',
        '// trailing',
      ].join('\n');
      const built = rows(src, 'ts').map((row) => row.map((s) => s.text).join(''));
      expect(built).toEqual(src.split('\n'));
    });

    it('produces no segment for a blank line inside a block comment', () => {
      const src = ['/*', '', '*/'].join('\n');
      expect(rows(src, 'ts')[1]).toEqual([]);
    });

    it('leaves an unterminated block comment open to the end without throwing', () => {
      const src = ['/* never closed', 'still comment', 'and still'].join('\n');
      expect(colorsOf(src, 'ts', 2)).toEqual([COMMENT]);
    });
  });

  describe('streaming', () => {
    /**
     * `buildLines` reuses the highlight of the unchanged line prefix, which is
     * what keeps a streamed block from being O(N) per chunk. Carry state has to
     * survive that reuse, or an append would silently re-colour earlier lines.
     */
    it('matches a from-scratch build after an incremental append', () => {
      const full = ['/* doc', ' * text', ' */', 'const a = 1;', 'const b = `x', 'y`;'].join('\n');
      const streamed = new CodeBlock('', 'ts', 400, 'default');
      const lines = full.split('\n');
      for (let i = 1; i <= lines.length; i++) {
        streamed.setCode(lines.slice(0, i).join('\n'), 'ts');
      }
      const oneShot = new CodeBlock(full, 'ts', 400, 'default');
      const read = (cb: CodeBlock) =>
        (cb as unknown as { lines: Seg[][] }).lines.map((row) =>
          row.map((s) => `${s.text}=${s.color}`),
        );
      expect(read(streamed)).toEqual(read(oneShot));
    });

    it('re-colours the tail when an append closes an open comment', () => {
      const cb = new CodeBlock('/* open\nstill', 'ts', 400, 'default');
      const read = () =>
        (cb as unknown as { lines: Seg[][] }).lines.map((row) => [
          ...new Set(row.map((s) => s.color)),
        ]);
      expect(read()[1]).toEqual([COMMENT]);
      cb.setCode('/* open\nstill */\nconst x = 1;', 'ts');
      // Live code again, and specifically NOT comment-coloured: keyword, plain
      // code, and the numeric literal.
      expect(read()[2]).toEqual([KEYWORD, CODE, NUMBER]);
    });
  });
});
