// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Markdown } from '../src/Markdown';
import { highlightedLanguages } from '../src/markdown-code';

/**
 * Syntax highlighting used to be gated entirely on the keyword table, which had
 * four entries (`js`, `ts`, `py`, `rust`) plus four aliases. `highlightLine()`
 * opened with `if (!keywords) return [{ text: line, color: theme.codeColor }]`,
 * so an unknown language did not get a degraded highlight — it got **none**,
 * losing comments, strings and numbers too, because the whole tokenizer sat
 * behind that lookup. A shell-heavy document rendered entirely in one color.
 *
 * The comment prefix was hardcoded in the tokenizer as well (`//` for every
 * language, `#` only for Python and Rust), so a shell `#` comment could not be
 * colored even where the keyword lookup succeeded.
 *
 * Lexical syntax is now described per language and consulted independently of
 * the keyword table, so a language can have either, both, or only one and still
 * be highlighted.
 */
describe('CodeBlock syntax highlighting: language coverage', () => {
  const KEYWORD = '#c084fc';
  const STRING = '#86efac';
  const COMMENT = '#64748b';
  const NUMBER = '#fbbf24';

  interface Seg {
    text: string;
    color: string;
  }

  /** Segments of one code line, as `text=color` pairs. */
  const segs = (code: string, lang: string, row = 0): string[] => {
    const md = new Markdown('```' + lang + '\n' + code + '\n```');
    const cb = md.content.children[0] as unknown as { lines: Seg[][] };
    return cb.lines[row].map((s) => `${s.text}=${s.color}`);
  };

  const colored = (code: string, lang: string, color: string, row = 0) =>
    segs(code, lang, row).filter((s) => s.endsWith(`=${color}`));

  /** Every segment's text joined — must always reproduce the input exactly. */
  const rebuilt = (code: string, lang: string, row = 0): string => {
    const md = new Markdown('```' + lang + '\n' + code + '\n```');
    const cb = md.content.children[0] as unknown as { lines: Seg[][] };
    return cb.lines[row].map((s) => s.text).join('');
  };

  describe('shell', () => {
    // The case that surfaced this: a real self-hosted-runner post where almost
    // every fence is bash, and the CJK comment was indistinguishable from the
    // commands around it.
    it('colors a # comment in bash', () => {
      expect(colored('# install the runner', 'bash', COMMENT)).toEqual([
        `# install the runner=${COMMENT}`,
      ]);
    });

    it('colors a CJK # comment in bash', () => {
      const line = '# 使用配置服务的方式安装运行器';
      expect(colored(line, 'bash', COMMENT)).toEqual([`${line}=${COMMENT}`]);
    });

    it('colors shell control keywords', () => {
      expect(colored('if true; then echo hi; fi', 'bash', KEYWORD)).toEqual([
        `if=${KEYWORD}`,
        `true=${KEYWORD}`,
        `then=${KEYWORD}`,
        `echo=${KEYWORD}`,
        `fi=${KEYWORD}`,
      ]);
    });

    it('colors a quoted shell string', () => {
      expect(colored('echo "hello"', 'bash', STRING)).toEqual([`"hello"=${STRING}`]);
    });

    it('does not treat // as a comment in bash', () => {
      // A path like `//server/share` or `s//x/` is not a comment. The prefix now
      // comes from the language table, so `//` must not apply here.
      expect(colored('echo //not-a-comment', 'bash', COMMENT)).toEqual([]);
      expect(rebuilt('echo //not-a-comment', 'bash')).toBe('echo //not-a-comment');
    });

    it.each(['sh', 'zsh', 'shell', 'console'])('treats %s as bash', (lang) => {
      expect(colored('# note', lang, COMMENT)).toEqual([`# note=${COMMENT}`]);
    });
  });

  describe('dialects map onto their base language', () => {
    // `jsx` was the telling case: a superset of a covered language that still
    // got nothing, because the lookup was exact-match with no dialect mapping.
    it.each(['jsx', 'mjs', 'cjs'])('highlights %s like js', (lang) => {
      expect(colored('const x = 1;', lang, KEYWORD)).toEqual([`const=${KEYWORD}`]);
    });

    it.each(['tsx', 'mts', 'cts'])('highlights %s like ts', (lang) => {
      expect(colored('interface A {}', lang, KEYWORD)).toEqual([`interface=${KEYWORD}`]);
    });
  });

  describe('markup and data languages', () => {
    it('colors a JSON string and number', () => {
      expect(colored('{"a": 1}', 'json', STRING)).toEqual([`"a"=${STRING}`]);
      expect(colored('{"a": 1}', 'json', NUMBER)).toEqual([`1=${NUMBER}`]);
    });

    it('does not treat a single quote as a string in JSON', () => {
      // JSON has no single-quoted strings; treating `'` as a delimiter would
      // mis-color hand-written or malformed JSON.
      expect(colored("{'a': 1}", 'json', STRING)).toEqual([]);
      expect(rebuilt("{'a': 1}", 'json')).toBe("{'a': 1}");
    });

    it('colors a // comment in jsonc but not in json', () => {
      expect(colored('// note', 'jsonc', COMMENT)).toEqual([`// note=${COMMENT}`]);
      expect(colored('// note', 'json', COMMENT)).toEqual([]);
    });

    it('colors an html tag name', () => {
      expect(colored('<div class="a">', 'html', KEYWORD)).toEqual([`div=${KEYWORD}`]);
    });

    it('does not color numbers inside html attributes', () => {
      // Numbers in markup attributes are noise rather than signal.
      expect(colored('<img width=100>', 'html', NUMBER)).toEqual([]);
    });

    it('colors a css value keyword and number', () => {
      expect(colored('a { margin: 0 auto; }', 'css', KEYWORD)).toEqual([`auto=${KEYWORD}`]);
      expect(colored('a { margin: 0 auto; }', 'css', NUMBER)).toEqual([`0=${NUMBER}`]);
    });

    it('does not claim a line comment for css', () => {
      // CSS has only block comments, which a line-based tokenizer cannot span,
      // so it must not pretend `//` is a comment.
      expect(colored('// not css', 'css', COMMENT)).toEqual([]);
    });
  });

  describe('languages with syntax but no keywords', () => {
    // These have no keyword table at all. Before, that meant no highlight
    // whatsoever; now they still get comments and strings.
    it.each(['yaml', 'yml', 'toml', 'ini', 'dockerfile', 'makefile'])(
      'colors a # comment in %s',
      (lang) => {
        expect(colored('# note', lang, COMMENT)).toEqual([`# note=${COMMENT}`]);
      },
    );

    it('colors a string in yaml', () => {
      expect(colored('key: "value"', 'yaml', STRING)).toEqual([`"value"=${STRING}`]);
    });

    it.each(['c', 'cpp', 'go', 'java', 'glsl'])('colors a // comment in %s', (lang) => {
      expect(colored('// note', lang, COMMENT)).toEqual([`// note=${COMMENT}`]);
    });
  });

  describe('the fence info string is normalized', () => {
    // `lang` is written verbatim from the fence and is publicly settable, so it
    // was never normalized — ```Bash resolved to nothing.
    it.each(['Bash', 'BASH', 'bAsH', '  bash  '])('resolves %s to bash', (lang) => {
      expect(colored('# note', lang, COMMENT)).toEqual([`# note=${COMMENT}`]);
    });

    it('ignores fence attributes after the language', () => {
      expect(colored('const x = 1;', 'ts title="a.ts"', KEYWORD)).toEqual([`const=${KEYWORD}`]);
    });
  });

  describe('invariants that must hold for every language', () => {
    const samples: Array<[string, string]> = [
      ['bash', '# c\necho "hi" 1'],
      ['json', '{"a": 1, "b": null}'],
      ['html', '<div class="a">x</div>'],
      ['css', 'a { color: red; }'],
      ['yaml', 'key: "v" # c'],
      ['ts', 'const x: number = 1; // c'],
      ['rust', "let c = 'x'; // c"],
      ['unknownlang', 'whatever # not a comment'],
    ];

    it.each(samples)('%s: segments rebuild the source line exactly', (lang, code) => {
      for (const [row, line] of code.split('\n').entries()) {
        expect(rebuilt(code, lang, row)).toBe(line);
      }
    });

    it('an unknown language still renders as a single plain segment', () => {
      // The fallback must stay: no table, no guessing.
      const out = segs('whatever # not a comment', 'unknownlang');
      expect(out).toHaveLength(1);
      expect(out[0].endsWith(`=${COMMENT}`)).toBe(false);
    });
  });

  describe('highlightedLanguages()', () => {
    it('reports the covered languages, sorted and deduped', () => {
      const langs = highlightedLanguages();
      expect(langs).toEqual([...langs].sort());
      expect(new Set(langs).size).toBe(langs.length);
    });

    it('covers every language the docs corpus actually uses', () => {
      // Counted over the docs `content/` directory when this gap was filed:
      // typescript 212, ts 164 (already covered) against bash 10, sh 2, json 2,
      // html 2, css 2, jsx 1, glsl 1 — all of which fell through to plain text.
      const langs = new Set(highlightedLanguages());
      for (const lang of ['typescript', 'ts', 'bash', 'sh', 'json', 'html', 'css', 'jsx', 'glsl']) {
        expect(langs.has(lang), `${lang} should be highlighted`).toBe(true);
      }
    });
  });
});
