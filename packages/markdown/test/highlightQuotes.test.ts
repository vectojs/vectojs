// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Markdown } from '../src/Markdown';

/**
 * `highlightLine` used to color from an opening quote to the end of the line
 * whenever the quote never closed, so a Rust lifetime (`&'a str`), an apostrophe
 * in trailing prose, or a stray quote turned the rest of the line into a green
 * "string". A quote is now only treated as a string delimiter when it actually
 * closes on the same line.
 */
describe('CodeBlock syntax highlighting: quote handling', () => {
  const STRING = '#86efac';
  const COMMENT = '#64748b';

  /** Segments of the first (only) code line, as `text=color` pairs. */
  const segs = (code: string, lang: string): string[] => {
    const md = new Markdown('```' + lang + '\n' + code + '\n```');
    const cb = md.content.children[0] as unknown as {
      lines: { text: string; color: string }[][];
    };
    return cb.lines[0].map((s) => `${s.text}=${s.color}`);
  };
  const stringSegs = (code: string, lang: string) =>
    segs(code, lang).filter((s) => s.endsWith(`=${STRING}`));

  /** The raw text of every segment, joined — must reproduce the input line. */
  const rebuilt = (code: string, lang: string): string => {
    const md = new Markdown('```' + lang + '\n' + code + '\n```');
    const cb = md.content.children[0] as unknown as {
      lines: { text: string; color: string }[][];
    };
    return cb.lines[0].map((s) => s.text).join('');
  };

  it('does not treat a Rust lifetime as a string', () => {
    const line = "let s: &'a str = 1;";
    // Nothing after the lifetime tick may be colored as a string.
    expect(stringSegs(line, 'rust')).toEqual([]);
    // And no character is lost or duplicated by the fall-through.
    expect(rebuilt(line, 'rust')).toBe(line);
  });

  it('still colors a properly closed single-quoted string', () => {
    expect(stringSegs("let c = 'x';", 'rust')).toEqual([`'x'=${STRING}`]);
  });

  it('still colors a properly closed double-quoted string', () => {
    expect(stringSegs('let s = "hi";', 'rust')).toEqual([`"hi"=${STRING}`]);
  });

  it('handles an escaped quote inside a closed string', () => {
    expect(stringSegs('let s = "a\\"b";', 'rust')).toEqual([`"a\\"b"=${STRING}`]);
  });

  it('does not let an unterminated double quote swallow the line', () => {
    expect(stringSegs('let s = "oops;', 'rust')).toEqual([]);
  });

  it('leaves an apostrophe in a trailing comment harmless', () => {
    // The comment branch already wins here; assert it stays a comment, not a string.
    const out = segs("let x = 1; // don't", 'js');
    expect(out.some((s) => s.endsWith(`=${COMMENT}`))).toBe(true);
    expect(out.some((s) => s.endsWith(`=${STRING}`))).toBe(false);
  });

  it('colors two closed strings on one line independently', () => {
    expect(stringSegs('f("a", "b");', 'js')).toEqual([`"a"=${STRING}`, `"b"=${STRING}`]);
  });

  it('still colors a closed template literal', () => {
    expect(stringSegs('let s = `hi`;', 'js')).toEqual(['`hi`=' + STRING]);
  });
});
