// The corpus is the whole claim of `markdown-transcript`: if its block mix does
// not match the measured real-world distribution, the aggregate figure it produces
// describes nothing. These tests pin the mix and the splitter so a later edit
// cannot silently reweight the benchmark.
import { describe, expect, test } from 'bun:test';
import { chunkify, transcript, turn } from './corpus.ts';

/** Measured over all 75 files of `vectojs-docs/content`: 2,503 non-space blocks. */
const REAL_MIX_PCT: Record<string, number> = {
  paragraph: 37.4,
  heading: 30.4,
  code: 13.5,
  list: 6.8,
  hr: 5.4,
  blockquote: 2.4,
  table: 2.0,
};

/**
 * Classify blank-line-separated blocks by their opening syntax.
 *
 * Deliberately NOT `marked.lexer`: `marked` resolves only from
 * `packages/markdown`, and while the benchmark bundler reaches it through that
 * package, a root-level `bun test` cannot. Adding a root dependency just to
 * classify a corpus this file already generates would be the wrong trade. The
 * corpus comes from known builders, so opening-syntax classification is exact
 * here — and `entry.ts` still reports the real `marked` mix in its params at run
 * time, which is the number a reader should audit.
 *
 * A ` ```math ` fence counts as `code`, which is what `marked` does too.
 */
function blockMix(doc: string): {
  counts: Record<string, number>;
  total: number;
} {
  const counts: Record<string, number> = {};
  let total = 0;
  for (const raw of doc.split(/\n{2,}/)) {
    const block = raw.trim();
    if (block.length === 0) continue;
    let type: string;
    if (block.startsWith('```')) type = 'code';
    else if (/^#{1,6}\s/.test(block)) type = 'heading';
    else if (block.startsWith('>')) type = 'blockquote';
    else if (block.startsWith('|')) type = 'table';
    else if (/^[-*]\s/.test(block)) type = 'list';
    else if (/^---+$/.test(block)) type = 'hr';
    else type = 'paragraph';
    counts[type] = (counts[type] ?? 0) + 1;
    total++;
  }
  return { counts, total };
}

describe('transcript corpus', () => {
  test('matches the measured real-world block mix within 5 points', () => {
    const { counts, total } = blockMix(transcript(6));
    for (const [type, expected] of Object.entries(REAL_MIX_PCT)) {
      const actual = (100 * (counts[type] ?? 0)) / total;
      // 5 points is deliberately loose: an integer number of blocks per turn
      // cannot hit 37.4% exactly, and pinning tighter would make this test a
      // description of the arithmetic rather than of the intent.
      expect(Math.abs(actual - expected)).toBeLessThan(5);
    }
  });

  test('exercises every block type that has a shipped reuse path', () => {
    const { counts } = blockMix(transcript(6));
    // The eight paths from CTX-0135..0147. `code` covers both the fenced-code
    // path and, for a `math` fence, the math path; `paragraph` covers both the
    // plain and the image-bearing shape.
    for (const type of ['paragraph', 'heading', 'code', 'list', 'table', 'blockquote']) {
      expect(counts[type] ?? 0).toBeGreaterThan(0);
    }
    const doc = transcript(6);
    expect(doc).toContain('```math');
    expect(doc).toContain('![reconciler timeline');
  });

  test('varies content per turn so no cache can answer for a later turn', () => {
    // If turns were byte-identical, the process-wide formula cache and the
    // paragraph memo would serve turns 2+ and the bench would measure the caches
    // rather than reconciliation.
    expect(turn(0)).not.toBe(turn(1));
    expect(turn(2)).not.toBe(turn(3));
  });

  test('math and figure appear only from turn 2', () => {
    expect(turn(0)).not.toContain('```math');
    expect(turn(1)).not.toContain('```math');
    expect(turn(2)).toContain('```math');
    expect(turn(0)).not.toContain('![reconciler timeline');
    expect(turn(2)).toContain('![reconciler timeline');
  });

  test('scales linearly in turns', () => {
    expect(transcript(2).length).toBe(turn(0).length + turn(1).length);
  });
});

describe('chunkify', () => {
  test('every granularity reassembles the document exactly', () => {
    const doc = transcript(2);
    for (const g of ['token', 'sentence', '16', '48']) {
      expect(chunkify(doc, g).join('')).toBe(doc);
    }
  });

  test('token granularity is far finer than the phases bench', () => {
    const doc = transcript(2);
    const tokens = chunkify(doc, 'token');
    const coarse = chunkify(doc, '48');
    // The reason this bench exists at token granularity: reuse work scales with
    // chunk count, and real SSE is an order of magnitude finer than the existing
    // shapes. Measured 47x spread in in-place updates token vs sentence.
    expect(tokens.length).toBeGreaterThan(coarse.length * 5);
  });

  test('token chunks are small and mostly land mid-construct', () => {
    const chunks = chunkify(transcript(1), 'token');
    const avg = chunks.reduce((s, c) => s + c.length, 0) / chunks.length;
    expect(avg).toBeLessThan(8);
    expect(avg).toBeGreaterThan(2);
  });

  test('rejects a nonsense granularity instead of silently misconfiguring', () => {
    // A typo here would otherwise produce a plausible-looking number at a
    // granularity nobody chose.
    expect(() => chunkify('abc', 'per-word')).toThrow('bad granularity');
    expect(() => chunkify('abc', '0')).toThrow('bad granularity');
  });
});
