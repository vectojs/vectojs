// The correctness contract for `incrementalLex.ts`, and the reason that module
// is allowed to exist at all.
//
// The optimisation it implements is a boundary placement: keep a prefix of the
// token list, re-lex only the text after it. A boundary chosen one line too
// early does not merely produce a slow parse, it produces a WRONG one — a code
// fence split into garbage, a setext heading demoted to a paragraph — and
// nothing downstream would notice, because the reconciler trusts the token list
// it is handed.
//
// So the tests here are differential, not example-based. Every one of them
// streams a document and asserts that the incremental token list is DEEPLY
// IDENTICAL to `marked.lexer()` of the same prefix, at every intermediate
// length. That equivalence is the contract; the timing win is secondary and is
// measured in `comparisons/stream-markdown-smd`, not here.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { marked, type Token } from 'marked';
import {
  type IncrementalLexCache,
  lexAppend,
  lexFull,
  type IncrementalLexResult,
} from '../src/incrementalLex';

// The `$$`/`$x$` math tokenizers are registered on the shared `marked` singleton
// by the worker module, and a block-level extension participates in boundary
// placement exactly like a built-in rule. Importing the worker for that side
// effect is what makes the `blockMath` cases below exercise the real
// configuration rather than plain marked; `self` is stubbed because the module
// installs an `onmessage` handler at import time.
beforeAll(async () => {
  vi.stubGlobal('self', {
    set onmessage(_handler: unknown) {},
    postMessage(): void {},
  });
  await import('../src/MarkdownWorker');
  vi.unstubAllGlobals();
});

/**
 * Stream `doc` in `chunkChars` slices and assert equivalence with a full lex
 * after **every** chunk, not just at the end. An end-only check would pass a
 * boundary bug that corrupts an intermediate state and happens to heal.
 */
function streamAndCompare(
  doc: string,
  chunkChars: number,
): { steps: number; finalCache: IncrementalLexCache; maxCharsLexed: number } {
  let cache: IncrementalLexCache | null = null;
  let steps = 0;
  let maxCharsLexed = 0;

  for (let end = 0; end <= doc.length; end += chunkChars) {
    const sliceEnd = Math.min(end + chunkChars, doc.length);
    if (sliceEnd === 0) continue;
    const soFar = doc.slice(0, sliceEnd);
    const result: IncrementalLexResult =
      cache === null ? lexFull(soFar) : lexAppend(cache, doc.slice(cache.source.length, sliceEnd));
    cache = result.cache;
    steps++;
    maxCharsLexed = Math.max(maxCharsLexed, result.charsLexed);

    const expected = marked.lexer(soFar);
    // `toEqual` on the token arrays is the whole assertion: token type, raw,
    // text, and every nested inline token must match. Comparing only `raw`
    // would miss a setext heading that kept its paragraph inline tokens.
    expect(result.tokens).toEqual(expected);
    expect(result.tokens.length).toBe(expected.length);
    // The concatenated raws must match what a full lex produces, which is NOT
    // always the source itself: marked trims a trailing bare list marker, so
    // `"- a\n- "` lexes to raw `"- a\n-\n"`. Comparing against the full lex's
    // own raws is the assertion that means something — comparing against the
    // source would encode a marked quirk as a requirement.
    expect(result.tokens.map((t: Token) => t.raw).join('')).toBe(
      expected.map((t: Token) => t.raw).join(''),
    );
    expect(cache.source).toBe(soFar);
  }

  return { steps, finalCache: cache!, maxCharsLexed };
}

/** Documents that exercise every construct whose boundary behaviour is subtle. */
const CORPUS: Record<string, string> = {
  // The shape the streaming benchmark and a real LLM transcript produce.
  prose: '# Title\n\nFirst paragraph with **bold** and `code`.\n\n## Second\n\nMore prose here.\n',

  // A fence that is still open swallows every following blank line, so no
  // boundary may be placed inside it.
  partialFence: 'Intro text.\n\n```js\nconst a = 1;\n\nconst b = 2;\n',
  // The same fence, closed, followed by more content.
  completedFence: 'Intro.\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter the fence.\n',
  // A fence containing what would otherwise look like block starts.
  fenceWithMarkdown:
    'Intro.\n\n```md\n# not a heading\n\n- not a list\n\n| not | a table |\n```\n\nDone.\n',

  // A delimiter row that has not finished arriving is not yet a table.
  partialTable: 'Intro.\n\n| a | b |\n| --- |',
  completedTable: 'Intro.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n\nAfter table.\n',

  // A blank line inside a list may or may not end it, depending on what follows.
  tightList: 'Intro.\n\n- one\n- two\n- three\n\nAfter list.\n',
  looseList: 'Intro.\n\n- one\n\n- two\n\n- three\n\nAfter list.\n',
  nestedList: 'Intro.\n\n- one\n  - nested\n    - deeper\n- two\n\nAfter.\n',
  // The dangerous case: an indented block after a blank line rejoins the list.
  listAbsorbsIndent: 'Intro.\n\n- item\n\n      indented continuation\n\nAfter.\n',
  taskList: 'Intro.\n\n- [ ] todo\n- [x] done\n\nAfter.\n',
  orderedList: 'Intro.\n\n1. one\n2. two\n\nAfter.\n',

  // A setext underline changes the PRECEDING line's token type, so a boundary
  // between the two would demote the heading to a paragraph.
  setextH1: 'Intro.\n\nHeading Text\n============\n\nBody.\n',
  setextH2: 'Intro.\n\nHeading Text\n------------\n\nBody.\n',
  // `---` after a blank line is an hr, after a paragraph line it is a setext H2.
  setextVsHr: 'Para one.\n\n---\n\nPara two.\n---\n\nPara three.\n',

  // Indented code continues across blank lines exactly like a loose list.
  indentedCode: 'Intro.\n\n    code line one\n\n    code line two\n\nAfter.\n',

  blockquote: 'Intro.\n\n> quoted line\n> another\n\nAfter.\n',
  blockquoteBlank: 'Intro.\n\n> first quote\n\n> second quote\n\nAfter.\n',
  blockquoteNested: 'Intro.\n\n> outer\n> > inner\n> > more\n\nAfter.\n',
  blockquoteWithFence: 'Intro.\n\n> ```js\n> code();\n> ```\n\nAfter.\n',

  html: 'Intro.\n\n<div class="x">\n  <p>text</p>\n</div>\n\nAfter.\n',
  htmlWithBlank: 'Intro.\n\n<div>\n\n  <p>text</p>\n\n</div>\n\nAfter.\n',

  hrVariants: 'A.\n\n---\n\nB.\n\n***\n\nC.\n\n___\n\nD.\n',
  manyBlankLines: 'One.\n\n\n\n\nTwo.\n\n\n\nThree.\n',
  noTrailingNewline: 'One.\n\nTwo.\n\nThree, unterminated',
  onlyWhitespace: '\n\n\n\n',
  singleChar: 'x',

  // Both `$$` block math and `$x$` inline math are VectoJS extensions registered
  // on the shared `marked` instance, so they must survive boundary placement too.
  blockMath: 'Intro.\n\n$$\nx = \\frac{1}{2}\n$$\n\nAfter math.\n',
  partialBlockMath: 'Intro.\n\n$$\nx = \\frac{1}{2}\n',
  inlineMath: 'Intro with $x + 1$ inline.\n\nAnd $y^2$ here.\n',

  // `:::` containers are a VectoJS extension with the same forward-reach
  // hazard as `blockMath`: an unterminated fence must degrade the instance.
  container: 'Intro.\n\n:::warning\nBe careful.\n:::\n\nAfter container.\n',
  partialContainer: 'Intro.\n\n:::warning\nBe careful.\n',
  nestedContainer: 'Intro.\n\n:::outer\n:::inner\ntext\n:::\n:::\n\nAfter.\n',

  // A footnote definition's continuation-consuming tokenizer has the same
  // forward-reach hazard as `blockMath`/`container` now that it can span a
  // blank line to absorb an indented second paragraph.
  footnoteDefMultiPara: 'Intro.\n\n[^1]: First line.\n\n    Second para.\n\nAfter.\n',
  partialFootnoteDefMultiPara: 'Intro.\n\n[^1]: First line.\n\n    Second para.\n',
  footnoteDefSingleLine: 'Intro.\n\n[^1]: note one\n\nAfter.\n',

  // Link reference definitions are the one construct that defeats prefix reuse
  // outright — the module must fall back, and the RESULT must still be right.
  linkDef: '[ref]: https://example.com\n\nUse [ref] in text.\n\nMore.\n',
  linkDefLate: 'Use [ref] in text.\n\nSome filler.\n\n[ref]: https://example.com\n',
  linkDefMidStream: 'Para one.\n\n[a]: https://a.example\n\nSee [a].\n\nPara two.\n',

  // CR normalisation desyncs raw-length offsets from source offsets.
  crlf: 'One.\r\n\r\nTwo.\r\n\r\nThree.\r\n',
  loneCr: 'One.\r\rTwo.\r',

  mixedEverything:
    '# Doc\n\nIntro para.\n\n- a\n- b\n\n```py\nx = 1\n```\n\n| h |\n| --- |\n| v |\n\n> quote\n\n---\n\n$$\ne=mc^2\n$$\n\nFinal para.\n',
};

describe('incrementalLex — equivalence with a full marked.lexer()', () => {
  // 1 char is the adversarial case: it puts a boundary decision at every single
  // character position, including mid-fence, mid-delimiter-row and between a
  // setext heading and its underline.
  for (const [name, doc] of Object.entries(CORPUS)) {
    it(`matches a full lex at every prefix, 1 char at a time: ${name}`, () => {
      streamAndCompare(doc, 1);
    });
  }

  // Chunk sizes that land boundaries at different offsets relative to the
  // blank lines. 32 is what the streaming comparison uses.
  for (const chunk of [2, 3, 7, 32]) {
    it(`matches a full lex at every prefix, ${chunk} chars at a time`, () => {
      for (const doc of Object.values(CORPUS)) streamAndCompare(doc, chunk);
    });
  }

  it('matches a full lex when the entire document arrives as one chunk', () => {
    for (const doc of Object.values(CORPUS)) {
      const result = lexFull(doc);
      expect(result.tokens).toEqual(marked.lexer(doc));
    }
  });

  it('matches a full lex on an empty source', () => {
    const result = lexFull('');
    expect(result.tokens).toEqual(marked.lexer(''));
    expect(result.tokens.length).toBe(0);
  });

  it('matches a full lex when an append is empty', () => {
    const first = lexFull('# Title\n\nBody.\n');
    const second = lexAppend(first.cache, '');
    expect(second.tokens).toEqual(marked.lexer('# Title\n\nBody.\n'));
  });
});

describe('incrementalLex — fuzzed documents and chunkings', () => {
  // A fixed corpus tests the constructs someone thought of. This tests the
  // ADJACENCIES nobody thought of: a fence directly against a table, a setext
  // underline right after a list, a definition between two blockquotes. Those
  // pairings are where a boundary rule breaks, and there are too many to
  // enumerate by hand.
  //
  // Seeded so a failure is reproducible — an unseeded fuzz test that fails once
  // and never again is worse than no test.
  function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Block fragments, deliberately including unterminated and partial forms. */
  const FRAGMENTS: string[] = [
    'Plain paragraph text.\n',
    'Text with **bold** and *em* and `code`.\n',
    '# ATX heading\n',
    '###### deep heading\n',
    'Setext heading\n==============\n',
    'Setext two\n----------\n',
    '- list item\n- another\n',
    '1. ordered\n2. second\n',
    '- [ ] task\n- [x] done\n',
    '- outer\n  - inner\n',
    '```js\nconst x = 1;\n```\n',
    '```\nunterminated fence\n',
    '```md\n# fenced heading\n\n- fenced list\n```\n',
    '    indented code\n',
    '| a | b |\n| --- | --- |\n| 1 | 2 |\n',
    '| partial | table |\n| --- |\n',
    '> blockquote\n> continued\n',
    '> quote with\n>\n> a blank quote line\n',
    '---\n',
    '***\n',
    '<div>\n<p>html block</p>\n</div>\n',
    '<span>inline html</span>\n',
    '$$\nx = y^2\n$$\n',
    '$$\nunterminated math\n',
    'Inline $a + b$ math here.\n',
    'Text with a [link](https://example.com).\n',
    '[def]: https://example.com\n',
    'Use of [def] reference.\n',
    '\n',
    '\n\n',
    'Trailing text without newline',
  ];

  it('matches a full lex for 300 random documents at random chunk sizes', () => {
    const rand = mulberry32(0x5eed1188);
    for (let trial = 0; trial < 300; trial++) {
      const parts = 1 + Math.floor(rand() * 6);
      let doc = '';
      for (let p = 0; p < parts; p++) {
        doc += FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)]!;
        // Blank lines between fragments are what create boundary candidates, so
        // vary them: sometimes none at all, which is its own edge case.
        const blanks = Math.floor(rand() * 3);
        doc += '\n'.repeat(blanks);
      }
      const chunk = 1 + Math.floor(rand() * 12);
      // A failure has to name the document and chunk size or it is not
      // reproducible from the log alone.
      try {
        streamAndCompare(doc, chunk);
      } catch (err) {
        throw new Error(
          `fuzz trial ${trial} failed at chunk=${chunk} doc=${JSON.stringify(doc)}\n${String(err)}`,
          { cause: err },
        );
      }
    }
  });

  it('matches a full lex with irregular chunk sizes within one stream', () => {
    // Real streams do not deliver uniform chunks. A varying size lands cut
    // decisions at offsets a fixed stride never visits.
    const rand = mulberry32(0xc0ffee88);
    for (let trial = 0; trial < 120; trial++) {
      let doc = '';
      for (let p = 0; p < 1 + Math.floor(rand() * 5); p++) {
        doc += FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)]!;
        doc += '\n'.repeat(Math.floor(rand() * 3));
      }

      let cache: IncrementalLexCache | null = null;
      let at = 0;
      while (at < doc.length) {
        const step = 1 + Math.floor(rand() * 9);
        const next = Math.min(at + step, doc.length);
        const soFar = doc.slice(0, next);
        const result =
          cache === null ? lexFull(soFar) : lexAppend(cache, doc.slice(cache.source.length, next));
        cache = result.cache;
        at = next;
        try {
          expect(result.tokens).toEqual(marked.lexer(soFar));
        } catch (err) {
          throw new Error(
            `irregular trial ${trial} diverged at len=${next} doc=${JSON.stringify(doc)}\n${String(err)}`,
            { cause: err },
          );
        }
      }
    }
  });
});

/**
 * Stream without the per-step full lex, and report only the window sizes.
 *
 * The equivalence tests above already establish correctness on these shapes; a
 * document big enough to demonstrate the SCALING claim would spend all its time
 * in the comparison lex (a full `marked.lexer()` plus a deep `toEqual` at each of
 * ~800 steps), which timed out under parallel workspace load. Separating the two
 * concerns keeps both fast and keeps each assertion about one thing.
 */
function streamWindows(
  doc: string,
  chunkChars: number,
): {
  finalCache: IncrementalLexCache;
  maxCharsLexed: number;
  totalCharsLexed: number;
} {
  let cache: IncrementalLexCache | null = null;
  let maxCharsLexed = 0;
  let totalCharsLexed = 0;
  for (let end = chunkChars; ; end += chunkChars) {
    const next = Math.min(end, doc.length);
    const result =
      cache === null
        ? lexFull(doc.slice(0, next))
        : lexAppend(cache, doc.slice(cache.source.length, next));
    cache = result.cache;
    maxCharsLexed = Math.max(maxCharsLexed, result.charsLexed);
    totalCharsLexed += result.charsLexed;
    if (next >= doc.length) break;
  }
  return { finalCache: cache!, maxCharsLexed, totalCharsLexed };
}

describe('incrementalLex — the boundary actually advances', () => {
  // Equivalence alone is satisfiable by always full-lexing, so this is the other
  // half of the contract: the work per chunk must stop growing with the document.
  it('lexes far less than the document once a boundary is established', () => {
    // 200 sections of the shape the streaming comparison uses.
    let doc = '';
    for (let i = 0; i < 200; i++) {
      doc +=
        `## Section ${i}\n\n` +
        `Paragraph ${i} with **bold text** and \`inline code\` and ` +
        `a [link](https://example.com/${i}) plus trailing prose.\n\n`;
    }

    const { finalCache, maxCharsLexed, totalCharsLexed } = streamWindows(doc, 32);

    expect(finalCache.degraded).toBe(false);
    // The boundary must have moved well past the start.
    expect(finalCache.stableOffset).toBeGreaterThan(doc.length * 0.9);
    // The decisive assertion: no single chunk ever lexed more than a small
    // window, where the old strategy lexed the whole accumulated document
    // (which at the last chunk is the full 25 000+ chars).
    expect(maxCharsLexed).toBeLessThan(1000);
    expect(doc.length).toBeGreaterThan(20000);
    // And in aggregate. The old strategy's total is ~chunks x doc/2, which for
    // this document is on the order of 10 million characters; anything within an
    // order of magnitude of that means the boundary is not doing its job.
    const oldStrategyTotal = (doc.length / 32) * (doc.length / 2);
    expect(totalCharsLexed).toBeLessThan(oldStrategyTotal * 0.05);
  });

  it('keeps per-chunk cost flat as the document grows', () => {
    // Same shape at two sizes. If the strategy were still O(document), the
    // largest chars-lexed figure would scale with the document; it must not.
    function maxWindow(sections: number): number {
      let doc = '';
      for (let i = 0; i < sections; i++) {
        doc += `## S${i}\n\nParagraph ${i} of ordinary prose text here.\n\n`;
      }
      return streamWindows(doc, 32).maxCharsLexed;
    }
    const small = maxWindow(25);
    const large = maxWindow(200);
    // Allow slack for where the chunk boundary lands, but the window must not
    // grow proportionally with the 8x document size.
    expect(large).toBeLessThan(small * 2);
  });

  it('reuses a stable prefix rather than re-reporting every token', () => {
    let doc = '';
    for (let i = 0; i < 50; i++) doc += `## S${i}\n\nBody ${i}.\n\n`;
    let cache = lexFull(doc.slice(0, 40)).cache;
    let sawReuse = false;
    for (let end = 40; end < doc.length; end += 32) {
      const next = Math.min(end + 32, doc.length);
      const result = lexAppend(cache, doc.slice(cache.source.length, next));
      if (result.reusedTokens > 0) sawReuse = true;
      cache = result.cache;
    }
    expect(sawReuse).toBe(true);
    expect(cache.stableCount).toBeGreaterThan(0);
  });
});

describe('incrementalLex — degradation is correct, permanent, and observable', () => {
  it('degrades on a link reference definition and still returns the right tokens', () => {
    const doc = 'Para one.\n\n[a]: https://a.example\n\nSee [a] here.\n';
    const { finalCache } = streamAndCompare(doc, 1);
    expect(finalCache.degraded).toBe(true);
    expect(finalCache.degradedReason).toBe('link-definition');
  });

  it('degrades on a carriage return and still returns the right tokens', () => {
    const doc = 'One.\r\n\r\nTwo.\r\n';
    const { finalCache } = streamAndCompare(doc, 1);
    expect(finalCache.degraded).toBe(true);
    expect(finalCache.degradedReason).toBe('carriage-return');
  });

  it('degrades on an open ::: fence and still returns the right tokens', () => {
    // The forward-reach hazard `markdown-container.ts` documents: an
    // unterminated `:::` can absorb arbitrarily much of the document once its
    // closing fence eventually arrives, exactly like `blockMath`'s `$$`.
    const doc = 'Intro.\n\n:::note\nHello\n\nWorld\n:::\n\nAfter.\n';
    const { finalCache } = streamAndCompare(doc, 1);
    expect(finalCache.degraded).toBe(true);
    expect(finalCache.degradedReason).toBe('container');
  });

  it('degrades on a footnote definition header and still returns the right tokens', () => {
    // The same forward-reach hazard, now that `footnoteDef`'s tokenizer can
    // consume indented continuation lines across a blank line: an unterminated
    // continuation can absorb arbitrarily much of the document once a
    // non-continuing line eventually arrives.
    const doc = 'Intro.\n\n[^1]: First.\n\n    Second.\n\nAfter.\n';
    const { finalCache } = streamAndCompare(doc, 1);
    expect(finalCache.degraded).toBe(true);
    expect(finalCache.degradedReason).toBe('footnote-def');
  });

  it('stays degraded for every later chunk once it has degraded', () => {
    // A definition arrives, then plenty of ordinary prose. A boundary must not
    // be re-established, because the definition is still in the source and a
    // suffix lex could not resolve reflinks that precede it.
    let cache = lexFull('[a]: https://a.example\n\nSee [a].\n').cache;
    expect(cache.degraded).toBe(true);
    for (let i = 0; i < 20; i++) {
      const result = lexAppend(cache, `\nOrdinary paragraph ${i}.\n\n`);
      cache = result.cache;
      expect(cache.degraded).toBe(true);
      expect(cache.stableCount).toBe(0);
      expect(result.tokens).toEqual(marked.lexer(cache.source));
    }
  });

  it('resolves a reference link defined after it is used', () => {
    // The retroactive case that makes definitions unfixable by boundary
    // placement: the `[ref]` inline token is emitted before the definition is
    // known, and a full lex resolves it anyway.
    const doc = 'See [ref] here.\n\nFiller paragraph.\n\n[ref]: https://example.com\n';
    const { finalCache } = streamAndCompare(doc, 1);
    expect(finalCache.degraded).toBe(true);
    // Explicitly assert the link resolved, not merely that tokens matched.
    const para = marked.lexer(doc)[0] as {
      tokens?: { type: string; href?: string }[];
    };
    expect(para.tokens?.some((t) => t.type === 'link' && t.href === 'https://example.com')).toBe(
      true,
    );
  });

  it('a degraded lex is still correct for a large document', () => {
    let doc = '[a]: https://a.example\n\n';
    for (let i = 0; i < 30; i++) doc += `Para ${i} using [a].\n\n`;
    const { finalCache } = streamAndCompare(doc, 16);
    expect(finalCache.degraded).toBe(true);
  });
});

describe('incrementalLex — cache invariants', () => {
  it('keeps tail as exactly the unstable suffix of source', () => {
    let doc = '';
    for (let i = 0; i < 30; i++) doc += `## S${i}\n\nBody ${i}.\n\n`;
    let cache = lexFull(doc.slice(0, 20)).cache;
    for (let end = 20; end <= doc.length; end += 13) {
      const next = Math.min(end + 13, doc.length);
      cache = lexAppend(cache, doc.slice(cache.source.length, next)).cache;
      // The invariant the boundary arithmetic rests on.
      expect(cache.tail).toBe(cache.source.slice(cache.stableOffset));
      expect(cache.stableOffset).toBe(
        cache.tokens.slice(0, cache.stableCount).reduce((a, t) => a + t.raw.length, 0),
      );
    }
  });

  it('never moves the boundary backwards', () => {
    let doc = '';
    for (let i = 0; i < 40; i++) doc += `Para ${i} text.\n\n`;
    let cache = lexFull(doc.slice(0, 10)).cache;
    let lastOffset = cache.stableOffset;
    for (let end = 10; end <= doc.length; end += 5) {
      const next = Math.min(end + 5, doc.length);
      cache = lexAppend(cache, doc.slice(cache.source.length, next)).cache;
      expect(cache.stableOffset).toBeGreaterThanOrEqual(lastOffset);
      lastOffset = cache.stableOffset;
    }
  });

  it('never places a boundary inside an unterminated fence', () => {
    // The failure mode that motivates the one-token lag: everything after an
    // open ``` is inside the code token, so the boundary must sit before it.
    const doc = 'Intro.\n\nPara.\n\n```js\nline one\n\nline two\n\nline three\n';
    let cache = lexFull(doc.slice(0, 8)).cache;
    for (let end = 8; end <= doc.length; end++) {
      cache = lexAppend(cache, doc.slice(cache.source.length, end)).cache;
      // Whatever the boundary is, the stable prefix must never include a token
      // that the growing fence is still able to change.
      const stable = cache.tokens.slice(0, cache.stableCount);
      expect(stable.some((t) => t.type === 'code')).toBe(false);
    }
    // And the final parse must still see one code token spanning the blanks.
    expect(cache.tokens.filter((t) => t.type === 'code').length).toBe(1);
  });
});
