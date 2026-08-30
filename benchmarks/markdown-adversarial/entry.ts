/**
 * Adversarial corpus bench — incrementalLex degradedReason + stable-boundary ratio.
 *
 * For each adversarial doc shape, streams through incrementalLex in 32-char
 * chunks (LLM token size) and reports:
 * - degraded + degradedReason (link-definition | container | footnote-def | carriage-return | null)
 * - stableOffset / doc length (stable-boundary ratio)
 * - charsLexed vs wholeDocumentCharsLexed
 * - timing vs whole-document control
 * - deep token equivalence gate (incremental vs marked.lexer(doc))
 *
 * Browser path uses benchmarks/_shared harness for quotable numbers;
 * Node/Bun path also works for quick collection without a headed browser.
 */

import { marked } from 'marked';
import {
  type IncrementalLexCache,
  lexAppend,
  lexFull,
} from '../../packages/markdown/src/incrementalLex';

// Ensure extensions (blockMath, container, footnote, emoji, etc.) are registered
// on the shared `marked` singleton before any lexing. MarkdownWorker registers
// them on import; stub self for non-browser runtimes.
async function ensureMarkedExtensions(): Promise<void> {
  const g = globalThis as unknown as { self?: unknown };
  if (typeof g.self === 'undefined') {
    (g as Record<string, unknown>).self = globalThis;
  }
  const s = (globalThis as unknown as { self: { onmessage?: unknown; postMessage?: unknown } })
    .self;
  if (s && typeof s.onmessage === 'undefined') s.onmessage = () => {};
  if (s && typeof s.postMessage === 'undefined') s.postMessage = () => {};
  await import('../../packages/markdown/src/MarkdownWorker');
}

import { ADVERSARIAL_CORPUS } from './corpus';

const CHUNK_CHARS = 32;
const TRIALS = 9;
const WARMUPS = 3;

function chunkify(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
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

function runIncremental(chunks: string[]): {
  cache: IncrementalLexCache;
  charsLexed: number;
  maxCharsLexed: number;
  tokens: number;
  ms: number;
} {
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

function runWholeDocument(chunks: string[]): {
  charsLexed: number;
  maxCharsLexed: number;
  tokens: number;
  ms: number;
} {
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

  // warmups
  for (let w = 0; w < WARMUPS; w++) {
    runIncremental(chunks);
    runWholeDocument(chunks);
  }

  const incSamples: number[] = [];
  const wholeSamples: number[] = [];
  let lastInc = runIncremental(chunks);
  let lastWhole = runWholeDocument(chunks);
  for (let t = 0; t < TRIALS; t++) {
    lastInc = runIncremental(chunks);
    incSamples.push(lastInc.ms);
    lastWhole = runWholeDocument(chunks);
    wholeSamples.push(lastWhole.ms);
  }

  const medianMs = median(incSamples);
  const wholeMedianMs = median(wholeSamples);
  const incCache = lastInc.cache;
  const stableOffset = incCache.stableOffset;
  const stableCount = incCache.stableCount;
  const stableRatio = doc.length === 0 ? 0 : stableOffset / doc.length;
  const preciseWhole = chunks.reduce((acc, _c, i) => {
    const prefixLen = chunks.slice(0, i + 1).join('').length;
    return acc + prefixLen;
  }, 0);

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

async function main(): Promise<void> {
  await ensureMarkedExtensions();

  // Browser harness path: if benchmarks/_shared client is available and we're in a page
  let isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
  let client: null | typeof import('../_shared/client') = null;
  if (isBrowser) {
    try {
      client = await import('../_shared/client');
      await client.awaitStart();
    } catch {
      isBrowser = false;
    }
  }

  const startedAt = performance.now();
  const results: CorpusResult[] = [];
  const allIssues: string[] = [];

  for (const [name, doc] of Object.entries(ADVERSARIAL_CORPUS)) {
    const r = measureOne(name, doc);
    results.push(r);
    if (!r.validationOk) allIssues.push(`${name}: ${r.issues.join('; ')}`);
  }

  const degradedCount = results.filter((r) => r.degraded).length;
  const avgStableNonDegraded =
    results.filter((r) => !r.degraded).reduce((a, r) => a + r.stableRatio, 0) /
    Math.max(1, results.filter((r) => !r.degraded).length);

  const summary = {
    degradedCount,
    total: results.length,
    avgStableNonDegraded: +avgStableNonDegraded.toFixed(4),
    degradedNames: results.filter((r) => r.degraded).map((r) => `${r.name}:${r.degradedReason}`),
    stableOk: results.every((r) => r.degraded || r.stableRatio > 0.85),
    validationOk: allIssues.length === 0,
    note:
      'Adversarial corpus for incrementalLex. Each doc streamed in 32-char chunks ' +
      'through lexFull/lexAppend and compared to marked.lexer(doc). degradedReason ' +
      'null means incremental path held; link-definition/container/footnote-def ' +
      'degrade permanently by design. stableRatio = stableOffset/docChars. ' +
      'CJK/RTL/emoji are inline and expected to stay incremental with high stable ratio.',
  };

  if (isBrowser && client) {
    const started = startedAt;
    await client.reportResult({
      name: 'markdown-adversarial',
      params: { CHUNK_CHARS, TRIALS, WARMUPS },
      rows: results,
      summary,
      issues: allIssues,
      durationMs: +(performance.now() - started).toFixed(1),
    });
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify({ summary, results }, null, 2);
    pre.style.cssText = 'font:12px monospace;white-space:pre-wrap;word-break:break-all';
    document.body.appendChild(pre);
  } else {
    // Node/Bun: write JSON to stdout and to comparisons stream dir if present
    const payload = {
      suite: 'markdown-adversarial',
      name: 'adversarial',
      engine:
        typeof navigator !== 'undefined'
          ? /firefox/i.test(navigator.userAgent)
            ? 'firefox'
            : 'chrome'
          : 'bun',
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : `bun/${Bun.version}`,
      generatedAt: new Date().toISOString(),
      params: { CHUNK_CHARS, TRIALS, WARMUPS },
      summary,
      results,
      issues: allIssues,
      validationOk: allIssues.length === 0,
      durationMs: +(performance.now() - startedAt).toFixed(1),
    };
    const json = JSON.stringify(payload, null, 2);
    console.log(json);

    // Also write to comparisons/stream-markdown-smd/results/adversarial-<date>.json when cwd is workspace
    try {
      const date = new Date().toISOString().slice(0, 10);
      const fs = await import('node:fs');
      const path = await import('node:path');
      const candidates = [
        'comparisons/stream-markdown-smd/results',
        '../../comparisons/stream-markdown-smd/results',
        './comparisons/stream-markdown-smd/results',
      ];
      for (const c of candidates) {
        try {
          const dir = path.resolve(c);
          if (fs.existsSync(path.resolve(c, '..'))) {
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, `adversarial-${date}.json`);
            fs.writeFileSync(file, json);
            console.error(`wrote ${file}`);
            break;
          }
        } catch {}
      }
    } catch {}
  }
}

main().catch(async (err) => {
  const msg = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack}` : String(err);
  console.error(msg);
  if (typeof window !== 'undefined') {
    try {
      const client = await import('../_shared/client');
      await client.reportFailure('markdown-adversarial', err);
    } catch {}
  } else {
    process.exit(1);
  }
});
