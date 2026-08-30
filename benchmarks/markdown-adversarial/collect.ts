/**
 * Node/Bun collector for adversarial corpus.
 * Run: bun run benchmarks/markdown-adversarial/collect.ts
 * Writes: comparisons/stream-markdown-smd/results/adversarial-<date>.json
 */

import { marked } from '../../packages/markdown/node_modules/marked/lib/marked.esm.js';

import {
  type IncrementalLexCache,
  lexAppend,
  lexFull,
} from '../../packages/markdown/src/incrementalLex';

// Ensure extensions are registered
async function ensureExtensions() {
  const g = globalThis as unknown as { self?: unknown };
  if (typeof g.self === 'undefined') (g as Record<string, unknown>).self = globalThis;
  const s = (globalThis as unknown as { self: { onmessage?: unknown; postMessage?: unknown } })
    .self;
  if (s && typeof (s as Record<string, unknown>).onmessage === 'undefined')
    (s as Record<string, unknown>).onmessage = () => {};
  if (s && typeof (s as Record<string, unknown>).postMessage === 'undefined')
    (s as Record<string, unknown>).postMessage = () => {};
  await import('../../packages/markdown/src/MarkdownWorker');
}

import { ADVERSARIAL_CORPUS } from './corpus';

const CHUNK_CHARS = 32;
const TRIALS = 9;
const WARMUPS = 3;

function chunkify(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

interface CorpusResult {
  name: string;
  docChars: number;
  chunks: number;
  degraded: boolean;
  degradedReason: string | null;
  stableOffset: number;
  stableCount: number;
  stableRatio: number;
  stableBoundaryRatio: number;
  tokens: number;
  charsLexed: number;
  wholeDocumentCharsLexed: number;
  maxCharsLexed: number;
  charsLexedRatio: number;
  medianMs: number;
  wholeMedianMs: number;
  speedup: number;
  tokensAgree: boolean;
  rawTilingOk: boolean;
  validationOk: boolean;
  issues: string[];
}

function runIncremental(chunks: string[]) {
  let cache: IncrementalLexCache | null = null;
  let charsLexed = 0;
  let maxCharsLexed = 0;
  let tokens = 0;
  const t0 = performance.now();
  for (const c of chunks) {
    const r = cache === null ? lexFull(c) : lexAppend(cache, c);
    cache = r.cache;
    charsLexed += r.charsLexed;
    maxCharsLexed = Math.max(maxCharsLexed, r.charsLexed);
    tokens = r.tokens.length;
  }
  const ms = performance.now() - t0;
  return { cache: cache!, charsLexed, maxCharsLexed, tokens, ms };
}

function runWholeDocument(chunks: string[]) {
  let source = '';
  let charsLexed = 0;
  let maxCharsLexed = 0;
  let tokens = 0;
  const t0 = performance.now();
  for (const c of chunks) {
    source += c;
    tokens = marked.lexer(source).length;
    charsLexed += source.length;
    maxCharsLexed = Math.max(maxCharsLexed, source.length);
  }
  const ms = performance.now() - t0;
  return { charsLexed, maxCharsLexed, tokens, ms };
}

function measureOne(name: string, doc: string): CorpusResult {
  const chunks = chunkify(doc, CHUNK_CHARS);
  const expected = marked.lexer(doc);

  for (let w = 0; w < WARMUPS; w++) {
    runIncremental(chunks);
    runWholeDocument(chunks);
  }

  const incSamples: number[] = [];
  const wholeSamples: number[] = [];
  let lastInc = runIncremental(chunks);
  runWholeDocument(chunks);
  for (let t = 0; t < TRIALS; t++) {
    lastInc = runIncremental(chunks);
    incSamples.push(lastInc.ms);
    const whole = runWholeDocument(chunks);
    wholeSamples.push(whole.ms);
  }

  const medianMs = median(incSamples);
  const wholeMedianMs = median(wholeSamples);
  const incCache = lastInc.cache;
  const stableOffset = incCache.stableOffset;
  const stableCount = incCache.stableCount;
  const stableRatio = doc.length === 0 ? 0 : stableOffset / doc.length;

  const preciseWhole = chunks.reduce(
    (acc, _, i) => acc + chunks.slice(0, i + 1).join('').length,
    0,
  );

  let finalTokens: unknown[] = [];
  {
    let cache: IncrementalLexCache | null = null;
    for (const c of chunks) {
      const r = cache === null ? lexFull(c) : lexAppend(cache, c);
      cache = r.cache;
      finalTokens = r.tokens as unknown[];
    }
  }

  const tokensAgree = JSON.stringify(finalTokens) === JSON.stringify(expected);
  const incRaw = (finalTokens as { raw: string }[]).map((t) => t.raw).join('');
  const expRaw = expected.map((t) => (t as { raw: string }).raw).join('');
  const rawTilingOk = incRaw === expRaw;

  const issues: string[] = [];
  if (!tokensAgree) issues.push('token tree differs from marked.lexer(doc)');
  if (!rawTilingOk) issues.push('raw tiling differs');
  if ((finalTokens as Array<{ type: string }>).length !== expected.length)
    issues.push(`token count ${finalTokens.length} != ${expected.length}`);

  const charsLexedRatio = lastInc.charsLexed === 0 ? 0 : preciseWhole / lastInc.charsLexed;

  return {
    name,
    docChars: doc.length,
    chunks: chunks.length,
    degraded: incCache.degraded,
    degradedReason: incCache.degradedReason,
    stableOffset,
    stableCount,
    stableRatio: +stableRatio.toFixed(4),
    stableBoundaryRatio: +stableRatio.toFixed(4),
    tokens: lastInc.tokens,
    charsLexed: lastInc.charsLexed,
    wholeDocumentCharsLexed: preciseWhole,
    maxCharsLexed: lastInc.maxCharsLexed,
    charsLexedRatio: +charsLexedRatio.toFixed(2),
    medianMs: +medianMs.toFixed(3),
    wholeMedianMs: +wholeMedianMs.toFixed(3),
    speedup:
      wholeMedianMs / Math.max(medianMs, 1e-6)
        ? +(wholeMedianMs / Math.max(medianMs, 1e-6)).toFixed(2)
        : 0,
    tokensAgree,
    rawTilingOk,
    validationOk: issues.length === 0,
    issues,
  };
}

async function main() {
  await ensureExtensions();
  const startedAt = performance.now();
  const results: CorpusResult[] = [];
  const allIssues: string[] = [];

  for (const [name, doc] of Object.entries(ADVERSARIAL_CORPUS)) {
    const r = measureOne(name, doc);
    results.push(r);
    if (!r.validationOk) allIssues.push(`${name}: ${r.issues.join('; ')}`);
    console.error(
      `${r.name}: degraded=${r.degraded} reason=${r.degradedReason} stableRatio=${r.stableRatio} charsLexed=${r.charsLexed} whole=${r.wholeDocumentCharsLexed} speedup=${r.speedup}x`,
    );
  }

  const degradedCount = results.filter((r) => r.degraded).length;
  const nonDeg = results.filter((r) => !r.degraded);
  const avgStableNonDegraded = nonDeg.length
    ? nonDeg.reduce((a, r) => a + r.stableRatio, 0) / nonDeg.length
    : 0;

  const payload = {
    suite: 'markdown-adversarial',
    name: 'adversarial',
    engine: 'bun',
    userAgent: `bun/${Bun.version}`,
    generatedAt: new Date().toISOString(),
    params: { CHUNK_CHARS, TRIALS, WARMUPS },
    summary: {
      degradedCount,
      total: results.length,
      avgStableNonDegraded: +avgStableNonDegraded.toFixed(4),
      degradedNames: results.filter((r) => r.degraded).map((r) => `${r.name}:${r.degradedReason}`),
      stableOk: results.every((r) => r.degraded || r.stableRatio > 0.85),
      validationOk: allIssues.length === 0,
      note:
        'Adversarial corpus for incrementalLex. Each doc streamed in 32-char chunks ' +
        'through lexFull/lexAppend vs marked.lexer(doc). degradedReason null = incremental held; ' +
        'link-definition/container/footnote-def degrade permanently. stableRatio=stableOffset/docChars.',
    },
    results,
    issues: allIssues,
    validationOk: allIssues.length === 0,
    durationMs: +(performance.now() - startedAt).toFixed(1),
  };

  const json = JSON.stringify(payload, null, 2);
  console.log(json);

  const fs = await import('node:fs');
  const path = await import('node:path');
  const date = new Date().toISOString().slice(0, 10);
  const candidates = [
    path.resolve('comparisons/stream-markdown-smd/results'),
    path.resolve('../../comparisons/stream-markdown-smd/results'),
    path.resolve('./comparisons/stream-markdown-smd/results'),
  ];
  let wrote = false;
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.resolve(dir, '..'))) {
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `adversarial-${date}.json`);
        fs.writeFileSync(file, json);
        console.error(`wrote ${file}`);
        wrote = true;
        break;
      }
    } catch (e) {
      console.error(`failed candidate ${dir}: ${e}`);
    }
  }
  if (!wrote) {
    // fallback: write to current worktree's comparisons
    const fallback = path.resolve(import.meta.dir, '../../comparisons/stream-markdown-smd/results');
    try {
      fs.mkdirSync(fallback, { recursive: true });
      const file = path.join(fallback, `adversarial-${date}.json`);
      fs.writeFileSync(file, json);
      console.error(`wrote fallback ${file}`);
    } catch (e) {
      console.error(`fallback also failed: ${e}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
