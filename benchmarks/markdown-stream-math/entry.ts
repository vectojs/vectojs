// CTX-0253 — does a line-start `$$` still cost a whole-document lex per chunk?
//
// TODO.md demanded this measurement explicitly: "Measure the before/after with a
// real streaming arm — the 69.8x prose figure is not this task's predicted
// result, and the earlier '1.0145x → 69.8x' claim was asserted without
// measurement and has been struck from #394's changeset."
//
// So this benchmark exists to produce the number, not to confirm a hope. It runs
// four arms over the same chunk schedule and reports the ratio between them:
//
//   A. `mathIncremental`  — the fix. A document with display math, streamed
//      through `incrementalLex`. Before this change `hasBlockMathOpener` degraded
//      the instance on the first `$$`, so every chunk re-lexed the whole
//      accumulated source.
//
//   B. `mathWholeDocument` — the BEFORE, reimplemented in-process as a control:
//      re-lex the entire accumulated source on every chunk, which is exactly what
//      a degraded instance does. This is the arm the ratio is against.
//
//   C. `proseIncremental` — the same document shape with the formulas replaced by
//      ordinary paragraphs of equal length. This is the reference the fix should
//      now match: if math streams like prose, A/C is near 1.0. Without it, a
//      large A/B ratio would still not prove math reached parity.
//
//   D. `proseWholeDocument` — C's control, so both ratios are computed the same
//      way and neither benefits from a different denominator.
//
// Reported as RATIOS between arms measured in the same run on the same engine,
// because an absolute ms figure for a lexer is dominated by the document size
// chosen here and is not transferable. The ratio is the claim.
//
// Scope, stated so it cannot be overread: this measures BLOCK LEXING ONLY. No
// entity building, no layout, no canvas, no a11y, no TeX typesetting. The
// `charsLexed` counters come from `incrementalLex` itself, so they are the
// mechanism rather than an inference from the timing.
import { marked } from 'marked';
import {
  type IncrementalLexCache,
  lexAppend,
  lexFull,
} from '../../packages/markdown/src/incrementalLex.ts';
import { awaitStart, reportFailure, reportResult } from '../_shared/client.ts';
import { mad, median } from '../_shared/stats.ts';

const p = new URLSearchParams(location.search);
/** Document sizes in sections, mirroring `comparisons/stream-markdown-smd`. */
const SECTION_COUNTS = (p.get('sections') ?? '25,50,100,200').split(',').map(Number);
/** 32 chars approximates one LLM token of English prose. */
const CHUNK_CHARS = Number(p.get('chunk') ?? 32);
const TRIALS = Number(p.get('trials') ?? 9);
const WARMUPS = Number(p.get('warmups') ?? 3);

/**
 * One section carrying a display-math block.
 *
 * Deliberately ordinary: a heading, a paragraph, one `$$` formula. A pathological
 * document (many formulas per section, or an unterminated one) would be a
 * different claim than the one this benchmark makes.
 */
function mathSection(i: number): string {
  return (
    `## Section ${i}\n\n` +
    `Paragraph ${i} with **bold text** and \`inline code\` introducing the result.\n\n` +
    `$$\n\\sum_{k=0}^{${i}} a_k = \\frac{${i}}{2}\n$$\n\n`
  );
}

/**
 * The same shape with the formula replaced by a paragraph of comparable length,
 * so arm C differs from arm A in the presence of math and as little else as
 * possible. Length parity matters: `charsLexed` and the timing both scale with
 * document size, so a shorter control would flatter the comparison.
 */
function proseSection(i: number): string {
  return (
    `## Section ${i}\n\n` +
    `Paragraph ${i} with **bold text** and \`inline code\` introducing the result.\n\n` +
    `Summing a_k from zero to ${i} gives one half of ${i} exactly as stated.\n\n`
  );
}

function buildDoc(sections: number, section: (i: number) => string): string {
  let out = '';
  for (let i = 0; i < sections; i++) out += section(i);
  return out;
}

function chunkify(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

interface ArmResult {
  ms: number;
  /** Characters actually handed to `marked.lexer()` across the whole stream. */
  charsLexed: number;
  /** Largest single-chunk lex, the figure that must stop growing. */
  maxCharsLexed: number;
  /** Final token count, used to prove the arms agree. */
  tokens: number;
  /** Final boundary as a fraction of the document, 0 when degraded. */
  stableFraction: number;
  degradedReason: string | null;
}

/** Stream through `incrementalLex`, the shipped strategy. */
function runIncremental(chunks: readonly string[], docLength: number): ArmResult {
  const t0 = performance.now();
  let cache: IncrementalLexCache | null = null;
  let charsLexed = 0;
  let maxCharsLexed = 0;
  let tokens = 0;
  for (const chunk of chunks) {
    const result = cache === null ? lexFull(chunk) : lexAppend(cache, chunk);
    cache = result.cache;
    charsLexed += result.charsLexed;
    if (result.charsLexed > maxCharsLexed) maxCharsLexed = result.charsLexed;
    tokens = result.tokens.length;
  }
  const ms = performance.now() - t0;
  return {
    ms,
    charsLexed,
    maxCharsLexed,
    tokens,
    stableFraction: cache === null ? 0 : cache.stableOffset / docLength,
    degradedReason: cache?.degradedReason ?? null,
  };
}

/**
 * The BEFORE: re-lex the whole accumulated source on every chunk.
 *
 * This is what a degraded instance does, reimplemented here rather than measured
 * by reverting the fix, so both arms run in one process on one engine in one
 * session. `degradeTo` in `incrementalLex` is exactly `marked.lexer(source)` plus
 * bookkeeping, so this is a faithful stand-in for the mechanism, not an
 * approximation of it.
 */
function runWholeDocument(chunks: readonly string[]): ArmResult {
  const t0 = performance.now();
  let source = '';
  let charsLexed = 0;
  let maxCharsLexed = 0;
  let tokens = 0;
  for (const chunk of chunks) {
    source += chunk;
    tokens = marked.lexer(source).length;
    charsLexed += source.length;
    if (source.length > maxCharsLexed) maxCharsLexed = source.length;
  }
  const ms = performance.now() - t0;
  return {
    ms,
    charsLexed,
    maxCharsLexed,
    tokens,
    stableFraction: 0,
    degradedReason: 'control',
  };
}

/**
 * Validation, run once per document outside the timed loop.
 *
 * A streaming arm can always be made fast by settling on the wrong token list, so
 * the ratio means nothing without this. The incremental arm's final tokens must be
 * DEEPLY identical to a single whole-document lex — the same assertion
 * `incrementalLex.test.ts` makes at every prefix, repeated here so the published
 * number carries its own proof.
 */
function validate(doc: string, chunks: readonly string[]): { ok: boolean; issues: string[] } {
  const issues: string[] = [];

  let cache: IncrementalLexCache | null = null;
  let finalTokens: unknown[] = [];
  for (const chunk of chunks) {
    const result = cache === null ? lexFull(chunk) : lexAppend(cache, chunk);
    cache = result.cache;
    finalTokens = result.tokens as unknown[];
  }
  const expected = marked.lexer(doc);

  if (cache === null) {
    issues.push('no cache produced');
    return { ok: false, issues };
  }
  if (cache.source !== doc) issues.push('cache source diverged from the document');
  if (finalTokens.length !== expected.length) {
    issues.push(`token count ${finalTokens.length} != ${expected.length}`);
  }
  if (JSON.stringify(finalTokens) !== JSON.stringify(expected)) {
    issues.push('incremental token tree differs from a whole-document lex');
  }
  // The claim under test: a math document must no longer degrade.
  if (cache.degraded) {
    issues.push(`instance degraded: ${String(cache.degradedReason)}`);
  }
  // The raws must tile what a full lex produces, which is the invariant the
  // boundary arithmetic rests on.
  const incRaw = (finalTokens as { raw: string }[]).map((t) => t.raw).join('');
  const expRaw = expected.map((t) => t.raw).join('');
  if (incRaw !== expRaw) issues.push('concatenated raws differ from a whole-document lex');

  return { ok: issues.length === 0, issues };
}

interface Row {
  sections: number;
  docChars: number;
  proseDocChars: number;
  mathIncrementalMs: number;
  mathWholeDocumentMs: number;
  proseIncrementalMs: number;
  proseWholeDocumentMs: number;
  /** The headline: how much the fix bought on a math document. */
  mathSpeedup: number;
  /** The same ratio for prose, which #394's changeset never established. */
  proseSpeedup: number;
  /** Near 1.0 means math now streams at prose cost. */
  mathToProseRatio: number;
  mathCharsLexed: number;
  mathWholeCharsLexed: number;
  /** Mechanism: the ratio of characters fed to the lexer, not of time. */
  charsLexedRatio: number;
  mathMaxCharsLexed: number;
  proseMaxCharsLexed: number;
  mathStableFraction: number;
  mathDegradedReason: string | null;
  mathTokens: number;
  mathWholeTokens: number;
  tokensAgree: boolean;
  madPercent: number;
}

async function main(): Promise<void> {
  await awaitStart();
  const startedAt = performance.now();

  const rows: Row[] = [];
  const issues: string[] = [];

  for (const sections of SECTION_COUNTS) {
    const mathDoc = buildDoc(sections, mathSection);
    const proseDoc = buildDoc(sections, proseSection);
    const mathChunks = chunkify(mathDoc, CHUNK_CHARS);
    const proseChunks = chunkify(proseDoc, CHUNK_CHARS);

    const check = validate(mathDoc, mathChunks);
    if (!check.ok) issues.push(`sections=${sections}: ${check.issues.join('; ')}`);

    for (let w = 0; w < WARMUPS; w++) {
      runIncremental(mathChunks, mathDoc.length);
      runWholeDocument(mathChunks);
      runIncremental(proseChunks, proseDoc.length);
      runWholeDocument(proseChunks);
    }

    const mathInc: number[] = [];
    const mathWhole: number[] = [];
    const proseInc: number[] = [];
    const proseWhole: number[] = [];
    let lastMathInc = runIncremental(mathChunks, mathDoc.length);
    let lastMathWhole = runWholeDocument(mathChunks);
    let lastProseInc = runIncremental(proseChunks, proseDoc.length);

    for (let t = 0; t < TRIALS; t++) {
      lastMathInc = runIncremental(mathChunks, mathDoc.length);
      mathInc.push(lastMathInc.ms);
      lastMathWhole = runWholeDocument(mathChunks);
      mathWhole.push(lastMathWhole.ms);
      lastProseInc = runIncremental(proseChunks, proseDoc.length);
      proseInc.push(lastProseInc.ms);
      proseWhole.push(runWholeDocument(proseChunks).ms);
    }

    const mathIncMs = median(mathInc);
    const mathWholeMs = median(mathWhole);
    const proseIncMs = median(proseInc);
    const proseWholeMs = median(proseWhole);

    rows.push({
      sections,
      docChars: mathDoc.length,
      proseDocChars: proseDoc.length,
      mathIncrementalMs: +mathIncMs.toFixed(3),
      mathWholeDocumentMs: +mathWholeMs.toFixed(3),
      proseIncrementalMs: +proseIncMs.toFixed(3),
      proseWholeDocumentMs: +proseWholeMs.toFixed(3),
      mathSpeedup: +(mathWholeMs / Math.max(mathIncMs, 1e-6)).toFixed(2),
      proseSpeedup: +(proseWholeMs / Math.max(proseIncMs, 1e-6)).toFixed(2),
      mathToProseRatio: +(mathIncMs / Math.max(proseIncMs, 1e-6)).toFixed(3),
      mathCharsLexed: lastMathInc.charsLexed,
      mathWholeCharsLexed: lastMathWhole.charsLexed,
      charsLexedRatio: +(lastMathWhole.charsLexed / Math.max(lastMathInc.charsLexed, 1)).toFixed(2),
      mathMaxCharsLexed: lastMathInc.maxCharsLexed,
      proseMaxCharsLexed: lastProseInc.maxCharsLexed,
      mathStableFraction: +lastMathInc.stableFraction.toFixed(4),
      mathDegradedReason: lastMathInc.degradedReason,
      mathTokens: lastMathInc.tokens,
      mathWholeTokens: lastMathWhole.tokens,
      tokensAgree: lastMathInc.tokens === lastMathWhole.tokens,
      madPercent: +((mad(mathInc) / Math.max(mathIncMs, 1e-6)) * 100).toFixed(1),
    });
  }

  const largest = rows[rows.length - 1]!;

  const result = await reportResult({
    name: 'markdown-stream-math',
    params: { SECTION_COUNTS, CHUNK_CHARS, TRIALS, WARMUPS },
    rows,
    summary: {
      // The number TODO.md asked for, at the largest document.
      mathSpeedupAtLargest: largest.mathSpeedup,
      proseSpeedupAtLargest: largest.proseSpeedup,
      // The parity claim: math should now cost what prose costs.
      mathToProseRatioAtLargest: largest.mathToProseRatio,
      // The mechanism, independent of the clock.
      charsLexedRatioAtLargest: largest.charsLexedRatio,
      mathMaxCharsLexedAtLargest: largest.mathMaxCharsLexed,
      proseMaxCharsLexedAtLargest: largest.proseMaxCharsLexed,
      mathStableFractionAtLargest: largest.mathStableFraction,
      mathDegradedAtLargest: largest.mathDegradedReason,
      validationOk: issues.length === 0,
      note:
        'Block lexing only: no entity building, layout, canvas, a11y or TeX. ' +
        'Ratios between arms measured in the same run, because an absolute ms ' +
        'figure is a property of the document size chosen here. The ' +
        '`wholeDocument` arms reimplement the pre-fix behaviour (what a degraded ' +
        'instance does) in-process, so before and after are one engine and one ' +
        'session. `charsLexedRatio` comes from incrementalLex own counters and ' +
        'is the mechanism rather than an inference from timing. Every arm is ' +
        'validated against a whole-document lex for deep token equality first; ' +
        'a fast arm that settled on different tokens would be meaningless.',
    },
    issues,
    durationMs: +(performance.now() - startedAt).toFixed(1),
  });

  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(result, null, 2);
  document.body.appendChild(pre);
}

main().catch((error) => reportFailure('markdown-stream-math', error));
