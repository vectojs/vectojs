/**
 * Streaming-markdown parse cost: `@vectojs/markdown`'s lexer strategy vs
 * [`streaming-markdown`](https://github.com/thetarnav/streaming-markdown) (`smd`).
 *
 * ## What this measures, and what it deliberately does not
 *
 * `@vectojs/markdown` does not own a parser. `lexMarkdown()`
 * (`packages/markdown/src/Markdown.ts:42`) is a thin wrapper over
 * `marked.lexer()`, and `marked` is a real runtime dependency. So a benchmark
 * pitting "our parser" against `smd` would in fact be `marked` vs `smd` — two
 * third-party libraries, neither of them ours, which ground rule 3 rejects.
 *
 * What *is* ours is the **strategy**. This suite measures two of them, in the
 * same process on the same hardware:
 *
 * - `wholeDocument` — what the worker did when this suite was written: cache the
 *   accumulated source, append each delta, call `marked.lexer()` on the **whole
 *   document again**, return only the changed token tail via a raw-string prefix
 *   match. Measured at 571x `smd` in Chrome 150, with a scaling exponent of 2.01.
 * - `vecto` — what it does now: `incrementalLex` tracks the last **stable block
 *   boundary** and lexes only the text after it, splicing onto the stable token
 *   prefix. Imported from the package source rather than reimplemented here, so
 *   this arm cannot drift from what production runs.
 *
 * `smd` instead advances a persistent parser state machine over just the new
 * chunk and never revisits earlier text, which remains the better design; the
 * question this suite now answers is how much of that gap the boundary closes.
 *
 * Two production streaming-Markdown renderers are measured on the same axis:
 *
 * - `streamdown` (2.5.0, Vercel) — shares our `marked`, and re-lexes the **whole
 *   accumulated document** every chunk, plus a `remend()` pass over that same
 *   whole document to auto-close unterminated syntax. Architecturally this is
 *   the `wholeDocument` control arm, which makes it the interesting case: if a
 *   real implementation reproduces the control's exponent, the control is
 *   validated as a fair model of the competing strategy rather than a straw man
 *   we built ourselves.
 * - `markstream` (`stream-markdown-parser` 1.2.0, the parser behind
 *   `markstream-vue`) — a `markdown-it` lineage parser via `markdown-it-ts`,
 *   whose `StreamParser` re-tokenizes only a **tail segment** after the last
 *   safe block boundary. That is the same strategy as our `incrementalLex`,
 *   arrived at independently, and the characters-fed columns below show the two
 *   agreeing to the byte.
 *
 * Three more shipped libraries round out the field (added 2026-08):
 *
 * - `incremark` (@incremark/core 0.3.10) — an incremental parser built for AI
 *   streaming, marked-engine like ours. Its `append()` re-parses the stable
 *   region between the last boundary and the current one each call, so it sits
 *   in the same strategy class as `vecto`/`markstream`; its per-call definition
 *   maps and AST rebuilds are part of what is measured.
 * - `react-markdown` (10.1.0) — the most common choice for rendering markdown
 *   in React. It has no separable parser export and no cross-render cache: the
 *   synchronous `Markdown` component runs remark over the **whole accumulated
 *   document** every render. This arm calls that exact component function and
 *   counts the element tree it returns; React reconciliation and DOM commit
 *   stay outside, exactly as our entity building does.
 * - `@ant-design/x-markdown` (2.9.0, Ant Design X) — an AI-chat renderer whose
 *   `useStreaming` hook is genuinely incremental (a per-character recognizer
 *   caches completed syntax), but whose component then re-runs a full
 *   marked-based parse to HTML plus sanitisation on every chunk. This arm
 *   renders the real component per chunk through `flushSync`, so both stages
 *   are inside the timed region; the React scheduling constant that adds is
 *   stated here rather than subtracted.
 *
 * All marked-based arms (`vecto`, `wholeDocument`, `streamdown`, `incremark`,
 * `x-markdown`) lex through the SAME workspace copy of `marked`, aliased at
 * bundle time, so engine constant factors cannot masquerade as strategy
 * differences. `react-markdown` uses micromark/remark, which is the point of
 * including it.
 *
 * Libraries under references/ that CANNOT run this axis are excluded with a
 * reason rather than silently dropped: `FluidMarkdown` is native
 * iOS/Android/HarmonyOS (no browser runtime), and `react-native-streamdown`
 * is a React Native port whose web twin `streamdown` is already measured
 * above.
 *
 * All are driven through the same counting sink as every other arm, so none
 * pays for rendering beyond what its own shipped pipeline performs before
 * producing output: `streamdown`'s per-block remark→React stage is memoised
 * and therefore outside the measured region, while the two React arms above
 * are timed at exactly the boundary their own code defines. Neither pays for
 * our canvas/entity work, exactly as our arm does not pay for their DOM.
 *
 * That is the axis measured here: **cost to stream a document in N chunks**,
 * which is a property of the strategy, not of either parser's constant factor.
 * Both arms are driven through an identical counting sink so that neither pays
 * for rendering — this isolates parse from paint on purpose, because our real
 * pipeline also builds canvas entities and `smd` builds DOM nodes, and those
 * are not comparable work.
 *
 * ## Scope difference (ground rule 3)
 *
 * `smd` is a parser and nothing else: ~1.6k lines, zero dependencies, no
 * layout, no rendering beyond an optional DOM renderer, no math, no
 * accessibility. `@vectojs/markdown` parses **and** lays out **and** renders to
 * canvas **and** projects a semantic DOM mirror for screen readers **and**
 * shapes TeX via MathJax. `smd` also implements a deliberately reduced
 * CommonMark subset. This suite compares only the streaming-parse axis, where
 * the two genuinely overlap; every other axis is ours alone and is not scored.
 *
 * ## Asymmetry that is stated, not hidden (ground rule 4)
 *
 * Our arm runs `marked.lexer()` on the main thread. In production that call
 * happens inside a Worker, so a real app's main thread does not block on it.
 * That does not change the CPU cost, which is what this measures and what
 * drains a battery, and the final chunk's latency is still bounded by it. The
 * `workerParity` arm below quantifies the postMessage overhead that the real
 * pipeline adds on top.
 */
import { createElement } from 'react';
// flushSync lives on react-dom, NOT on react-dom/client (which only exports
// createRoot/hydrateRoot) — importing it from there bundles undefined.
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import XMarkdown from '@ant-design/x-markdown';
import { createIncremarkParser } from '@incremark/core';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Lexer, marked } from 'marked';
import remend from 'remend';
import { getMarkdown, parseMarkdownToStructure } from 'stream-markdown-parser';
import * as smd from 'streaming-markdown';
import { parseMarkdownIntoBlocks } from 'streamdown';
import {
  type IncrementalLexCache,
  lexAppend,
  lexFull,
} from '../../packages/markdown/src/incrementalLex';

// ---------------------------------------------------------------------------
// Workload
// ---------------------------------------------------------------------------

/** Chunk size in characters. 32 approximates an LLM token in English prose. */
const CHUNK_CHARS = 32;

/** Document sizes, in "sections". Each section is a heading + a paragraph. */
const SECTION_COUNTS = [25, 50, 100, 200] as const;

/** Trials per arm, and warmups before each. */
const TRIALS = 9;
const WARMUPS = 3;

/**
 * One section of representative streamed prose: a heading, then a paragraph
 * carrying the inline constructs an LLM actually emits (bold, code span, link).
 *
 * Deliberately NOT a pathological document. The finding this suite reports is
 * about ordinary content; a crafted worst case would be a different claim.
 */
function section(i: number): string {
  return (
    `## Section ${i}\n\n` +
    `Paragraph ${i} with **bold text** and \`inline code\` and ` +
    `a [link](https://example.com/${i}) plus trailing prose.\n\n`
  );
}

function buildDoc(sections: number): string {
  let out = '';
  for (let i = 0; i < sections; i++) out += section(i);
  return out;
}

function chunkify(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

// ---------------------------------------------------------------------------
// Sinks — identical shape for both arms so neither pays for rendering
// ---------------------------------------------------------------------------

interface Sink {
  tokens: number;
  textChars: number;
}

function smdSink(sink: Sink): smd.Renderer<null> {
  return {
    data: null,
    add_token: () => {
      sink.tokens++;
    },
    end_token: () => {},
    add_text: (_data, text) => {
      sink.textChars += text.length;
    },
    set_attr: () => {},
  };
}

// ---------------------------------------------------------------------------
// Timing helpers
// ---------------------------------------------------------------------------

function median(samples: number[]): number {
  const s = samples.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * A 5% trimmed mean. Used alongside the median because Gecko quantises
 * `performance.now()` to whole microseconds under COI, and a median can lock
 * onto one quantum (the artifact recorded in AGENTS.md for `refreshHz`).
 */
function trimmedMean(samples: number[]): number {
  const s = samples.slice().sort((a, b) => a - b);
  const drop = Math.floor(s.length * 0.05);
  const kept = s.slice(drop, s.length - drop || undefined);
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

interface ArmResult {
  totalMs: number;
  perChunkUs: number;
  samples: number[];
  trimmedMeanMs: number;
}

/** `smd`: feed each chunk once into a persistent parser. */
function runSmd(chunks: string[]): { result: ArmResult; sink: Sink } {
  const samples: number[] = [];
  let lastSink: Sink = { tokens: 0, textChars: 0 };
  for (let t = 0; t < WARMUPS + TRIALS; t++) {
    const sink: Sink = { tokens: 0, textChars: 0 };
    const t0 = performance.now();
    const parser = smd.parser(smdSink(sink));
    for (const c of chunks) smd.parser_write(parser, c);
    smd.parser_end(parser);
    const elapsed = performance.now() - t0;
    if (t >= WARMUPS) samples.push(elapsed);
    lastSink = sink;
  }
  const ms = median(samples);
  return {
    result: {
      totalMs: ms,
      perChunkUs: (ms * 1000) / chunks.length,
      samples,
      trimmedMeanMs: trimmedMean(samples),
    },
    sink: lastSink,
  };
}

/**
 * The OLD strategy, kept as a control arm: accumulate the source and re-lex the
 * whole document per chunk, including the raw-prefix match that decides how much
 * of the token array is reused.
 *
 * This is no longer what `@vectojs/markdown` does — it is what it did when this
 * suite first ran, and it stays because a before/after in the same process on the
 * same hardware is the only honest way to report the improvement. Deleting it
 * would leave the fix's effect resting on a comparison against a number measured
 * on a different day.
 */
function runWholeDocumentStrategy(chunks: string[]): {
  result: ArmResult;
  sink: Sink;
  prefixReuse: number;
} {
  const samples: number[] = [];
  let lastSink: Sink = { tokens: 0, textChars: 0 };
  let prefixMatchedTotal = 0;
  let tokensReturnedTotal = 0;

  for (let t = 0; t < WARMUPS + TRIALS; t++) {
    const sink: Sink = { tokens: 0, textChars: 0 };
    let acc = '';
    let prevRaws: string[] = [];
    let matchedThisTrial = 0;
    let returnedThisTrial = 0;

    const t0 = performance.now();
    for (const c of chunks) {
      acc += c;
      const tokens = marked.lexer(acc);
      // The worker's prefix match, reproduced: compare raw strings positionally
      // and keep the longest stable prefix.
      let matchLen = 0;
      const limit = Math.min(prevRaws.length, tokens.length);
      while (matchLen < limit && prevRaws[matchLen] === tokens[matchLen]!.raw) matchLen++;
      matchedThisTrial += matchLen;
      returnedThisTrial += tokens.length - matchLen;
      prevRaws = tokens.map((tok) => tok.raw);
      sink.tokens = tokens.length;
    }
    const elapsed = performance.now() - t0;
    if (t >= WARMUPS) {
      samples.push(elapsed);
      prefixMatchedTotal += matchedThisTrial;
      tokensReturnedTotal += returnedThisTrial;
    }
    lastSink = sink;
  }

  const ms = median(samples);
  const totalConsidered = prefixMatchedTotal + tokensReturnedTotal;
  return {
    result: {
      totalMs: ms,
      perChunkUs: (ms * 1000) / chunks.length,
      samples,
      trimmedMeanMs: trimmedMean(samples),
    },
    sink: lastSink,
    // Fraction of token slots the delta protocol successfully reused. High even
    // in the old arm — it saves entity rebuilds, it just could not save lexing.
    prefixReuse: totalConsidered === 0 ? 0 : prefixMatchedTotal / totalConsidered,
  };
}

/**
 * The CURRENT strategy: `incrementalLex`, imported from the shipped package
 * source rather than reimplemented here.
 *
 * Importing the real module is deliberate. The old arm above is a reimplementation
 * of the worker's logic, which was accurate when written but is exactly the kind
 * of copy that silently stops matching the thing it claims to measure. This arm
 * calls what production calls, so it cannot drift.
 */
function runIncrementalStrategy(chunks: string[]): {
  result: ArmResult;
  sink: Sink;
  prefixReuse: number;
  charsLexed: number;
  degraded: boolean;
} {
  const samples: number[] = [];
  let lastSink: Sink = { tokens: 0, textChars: 0 };
  let prefixMatchedTotal = 0;
  let tokensReturnedTotal = 0;
  let charsLexedLast = 0;
  let degradedLast = false;

  for (let t = 0; t < WARMUPS + TRIALS; t++) {
    const sink: Sink = { tokens: 0, textChars: 0 };
    let cache: IncrementalLexCache | null = null;
    let prevRaws: string[] = [];
    let matchedThisTrial = 0;
    let returnedThisTrial = 0;
    let charsThisTrial = 0;

    const t0 = performance.now();
    for (const c of chunks) {
      const res = cache === null ? lexFull(c) : lexAppend(cache, c);
      cache = res.cache;
      const tokens = res.tokens;
      charsThisTrial += res.charsLexed;
      // The same prefix match the worker runs, starting where the incremental
      // lex has already proven the tokens identical.
      let matchLen = Math.min(res.reusedTokens, Math.min(prevRaws.length, tokens.length));
      const limit = Math.min(prevRaws.length, tokens.length);
      while (matchLen < limit && prevRaws[matchLen] === tokens[matchLen]!.raw) matchLen++;
      matchedThisTrial += matchLen;
      returnedThisTrial += tokens.length - matchLen;
      prevRaws = tokens.map((tok) => tok.raw);
      sink.tokens = tokens.length;
    }
    const elapsed = performance.now() - t0;
    if (t >= WARMUPS) {
      samples.push(elapsed);
      prefixMatchedTotal += matchedThisTrial;
      tokensReturnedTotal += returnedThisTrial;
      charsLexedLast = charsThisTrial;
    }
    degradedLast = cache?.degraded ?? false;
    lastSink = sink;
  }

  const ms = median(samples);
  const totalConsidered = prefixMatchedTotal + tokensReturnedTotal;
  return {
    result: {
      totalMs: ms,
      perChunkUs: (ms * 1000) / chunks.length,
      samples,
      trimmedMeanMs: trimmedMean(samples),
    },
    sink: lastSink,
    prefixReuse: totalConsidered === 0 ? 0 : prefixMatchedTotal / totalConsidered,
    // Total characters handed to `marked.lexer()` across the stream. This is the
    // mechanism the timing reflects, reported alongside it so a reader can see
    // WHY the number moved rather than taking the number on trust.
    charsLexed: charsLexedLast,
    degraded: degradedLast,
  };
}

/**
 * Single full-document lex, no streaming. Isolates whether the superlinearity
 * is in the streaming strategy (O(chunks) x O(doc)) or already present in one
 * `marked.lexer()` call. This distinction is the whole finding, so it is
 * measured rather than assumed.
 */
function runSingleLex(doc: string): ArmResult {
  const samples: number[] = [];
  for (let t = 0; t < WARMUPS + TRIALS; t++) {
    const t0 = performance.now();
    marked.lexer(doc);
    const elapsed = performance.now() - t0;
    if (t >= WARMUPS) samples.push(elapsed);
  }
  const ms = median(samples);
  return {
    totalMs: ms,
    perChunkUs: 0,
    samples,
    trimmedMeanMs: trimmedMean(samples),
  };
}

/**
 * `streamdown` 2.5.0: `remend()` the accumulated document to auto-close
 * unterminated syntax, then `parseMarkdownIntoBlocks()` it into block sources.
 *
 * This is streamdown's real per-chunk parse path, taken from its own component:
 * `index.tsx` memoises `processedChildren = remend(children)` on `children` and
 * `blocks = parseMarkdownIntoBlocksFn(processedChildren)` on that, so every new
 * chunk invalidates both and re-runs them over the whole accumulated string.
 *
 * What is deliberately NOT in the measured region: the per-block
 * remark→rehype→React stage. streamdown memoises `Block` on the block's
 * `content` string, so that stage is block-incremental and only re-runs for
 * blocks whose text changed. Including it would be comparing their rendering to
 * our parsing (ground rule 4), and excluding it is the same choice made for our
 * own entity building.
 *
 * `remend` is timed separately as well as together, because it is also
 * O(document) per chunk and would otherwise be silently attributed to "parsing".
 */
function runStreamdown(chunks: string[]): {
  result: ArmResult;
  sink: Sink;
  remendOnlyMs: number;
  blocks: number;
} {
  const samples: number[] = [];
  const remendSamples: number[] = [];
  let lastSink: Sink = { tokens: 0, textChars: 0 };
  let lastBlocks = 0;

  for (let t = 0; t < WARMUPS + TRIALS; t++) {
    const sink: Sink = { tokens: 0, textChars: 0 };
    let acc = '';
    let remendElapsed = 0;

    const t0 = performance.now();
    for (const c of chunks) {
      acc += c;
      const r0 = performance.now();
      const fixed = remend(acc);
      remendElapsed += performance.now() - r0;
      const blocks = parseMarkdownIntoBlocks(fixed);
      // Identical counting sink to every other arm: count the units produced and
      // the text they carry, and do nothing with them.
      sink.tokens = blocks.length;
      let chars = 0;
      for (const b of blocks) chars += b.length;
      sink.textChars = chars;
    }
    const elapsed = performance.now() - t0;
    if (t >= WARMUPS) {
      samples.push(elapsed);
      remendSamples.push(remendElapsed);
    }
    lastSink = sink;
    lastBlocks = sink.tokens;
  }

  const ms = median(samples);
  return {
    result: {
      totalMs: ms,
      perChunkUs: (ms * 1000) / chunks.length,
      samples,
      trimmedMeanMs: trimmedMean(samples),
    },
    sink: lastSink,
    remendOnlyMs: median(remendSamples),
    blocks: lastBlocks,
  };
}

/**
 * `stream-markdown-parser` 1.2.0, the parser behind `markstream-vue`.
 *
 * `parseMarkdownToStructure(acc, md, { final: false })` is what markstream calls
 * per chunk. Its `factory` defaults `experimental.stream` to true, so this routes
 * through `markdown-it-ts`'s `StreamParser`, which re-tokenizes only the tail
 * after the last safe block boundary — the same strategy as `incrementalLex`.
 *
 * Note this arm produces a **full node structure** per chunk, not a token array:
 * it is doing strictly more per call than our arm, whose entity building happens
 * afterwards and outside this measurement. That asymmetry is stated rather than
 * corrected, because there is no smaller call in its public API to compare
 * against; the characters-fed column is the like-for-like figure.
 *
 * Vue is not involved. `stream-markdown-parser` is a standalone npm package with
 * no Vue dependency, which is what makes it possible to separate the parser from
 * the reactivity layer that markstream-vue's own 12073 ms self-report diagnoses.
 */
function runMarkstream(chunks: string[]): {
  result: ArmResult;
  sink: Sink;
  nodes: number;
} {
  const samples: number[] = [];
  let lastSink: Sink = { tokens: 0, textChars: 0 };
  let lastNodes = 0;

  for (let t = 0; t < WARMUPS + TRIALS; t++) {
    const sink: Sink = { tokens: 0, textChars: 0 };
    // A fresh instance per trial, so trial N never reads trial N-1's stream
    // cache — the same reason every other arm rebuilds its state per trial.
    const md = getMarkdown(`bench-${t}`);
    let acc = '';

    const t0 = performance.now();
    for (const c of chunks) {
      acc += c;
      const nodes = parseMarkdownToStructure(acc, md, { final: false });
      sink.tokens = nodes.length;
    }
    const elapsed = performance.now() - t0;
    if (t >= WARMUPS) samples.push(elapsed);
    lastSink = sink;
    lastNodes = sink.tokens;
  }

  const ms = median(samples);
  return {
    result: {
      totalMs: ms,
      perChunkUs: (ms * 1000) / chunks.length,
      samples,
      trimmedMeanMs: trimmedMean(samples),
    },
    sink: lastSink,
    nodes: lastNodes,
  };
}

/**
 * Deep-compare helper for ASTs that carry position metadata. incremark computes
 * node positions per segment parse, so a block finalised mid-stream carries the
 * offsets of the segment it was parsed in, which legitimately differ from the
 * same block one-shot over the whole document. Positions are provenance, not
 * semantics — they are stripped before comparison so the gate stays structural.
 */
function stripPositions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPositions);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k !== 'position') out[k] = stripPositions(v);
    }
    return out;
  }
  return value;
}

/**
 * @incremark/core 0.3.10: feed each chunk once into a persistent parser, then
 * `finalize()`.
 *
 * `append()` re-parses the stable region between the previous boundary and the
 * current one on every call (its `astBuilder.parse(stableText)`), plus the
 * pending tail, and rebuilds definition maps and an aggregate AST across ALL
 * completed blocks per call — those O(document) bookkeeping passes are part of
 * its shipped per-chunk cost and stay inside the timed region.
 *
 * The counting sink consumes `IncrementalUpdate`: completed + pending blocks
 * per update, `rawText` lengths for text characters.
 */
function runIncremark(chunks: string[]): { result: ArmResult; sink: Sink; blocks: number } {
  const samples: number[] = [];
  let lastSink: Sink = { tokens: 0, textChars: 0 };
  let lastBlocks = 0;

  for (let t = 0; t < WARMUPS + TRIALS; t++) {
    const sink: Sink = { tokens: 0, textChars: 0 };
    // Fresh parser per trial, like every other arm: trial N must never read
    // trial N-1's incremental state.
    const parser = createIncremarkParser({ gfm: true });

    const t0 = performance.now();
    for (const c of chunks) {
      const update = parser.append(c);
      sink.tokens = update.completed.length + update.pending.length;
      let chars = 0;
      for (const b of update.completed) chars += b.rawText.length;
      for (const b of update.pending) chars += b.rawText.length;
      sink.textChars = chars;
    }
    const fin = parser.finalize();
    sink.tokens = fin.ast.children.length;
    const elapsed = performance.now() - t0;
    if (t >= WARMUPS) samples.push(elapsed);
    lastSink = sink;
    lastBlocks = fin.ast.children.length;
  }

  const ms = median(samples);
  return {
    result: {
      totalMs: ms,
      perChunkUs: (ms * 1000) / chunks.length,
      samples,
      trimmedMeanMs: trimmedMean(samples),
    },
    sink: lastSink,
    blocks: lastBlocks,
  };
}

/** Counts elements and text characters in the React element tree an FC returned. */
function countReactTree(node: unknown): { elements: number; textChars: number } {
  let elements = 0;
  let textChars = 0;
  const walk = (n: unknown): void => {
    if (n === null || n === undefined || typeof n === 'boolean') return;
    if (typeof n === 'string' || typeof n === 'number') {
      textChars += String(n).length;
      return;
    }
    if (Array.isArray(n)) {
      for (const child of n) walk(child);
      return;
    }
    if (typeof n === 'object') {
      const el = n as { props?: { children?: unknown } };
      if (el.props !== undefined && el.props !== null && typeof el.props === 'object') {
        elements++;
        walk(el.props.children);
      }
    }
  };
  walk(node);
  return { elements, textChars };
}

/**
 * react-markdown 10.1.0: call its synchronous `Markdown` component directly per
 * chunk with the accumulated document.
 *
 * This is the library's real per-render work minus only what React itself does
 * with the return value: `Markdown` builds a fresh unified processor
 * (remark-parse + remark-gfm + remark-rehype), parses the WHOLE accumulated
 * document, runs the tree transforms synchronously, and converts hast to React
 * elements — no cross-render cache exists to exclude anything. There is no
 * hooks/state in this path, so invoking the function component outside a
 * renderer is exact, not an approximation.
 *
 * The element-tree counting walk is inside the timed loop, mirroring how every
 * other arm counts its output inside the region.
 */
function runReactMarkdown(chunks: string[]): { result: ArmResult; sink: Sink } {
  const samples: number[] = [];
  let lastSink: Sink = { tokens: 0, textChars: 0 };

  for (let t = 0; t < WARMUPS + TRIALS; t++) {
    const sink: Sink = { tokens: 0, textChars: 0 };
    let acc = '';

    const t0 = performance.now();
    for (const c of chunks) {
      acc += c;
      const tree = ReactMarkdown({ children: acc, remarkPlugins: [remarkGfm] });
      const counted = countReactTree(tree);
      sink.tokens = counted.elements;
      sink.textChars = counted.textChars;
    }
    const elapsed = performance.now() - t0;
    if (t >= WARMUPS) samples.push(elapsed);
    lastSink = sink;
  }

  const ms = median(samples);
  return {
    result: {
      totalMs: ms,
      perChunkUs: (ms * 1000) / chunks.length,
      samples,
      trimmedMeanMs: trimmedMean(samples),
    },
    sink: lastSink,
  };
}

/**
 * A detached React root rendering the real `@ant-design/x-markdown` component.
 *
 * Detached container: React commits fine without the node being in the
 * document, and keeping it out of layout keeps the page (and the other arms'
 * timings) unaffected by this arm's DOM.
 */
function createXMarkdownHost(): {
  step: (acc: string) => void;
  html: () => string;
  sink: () => Sink;
  dispose: () => void;
} {
  const container = document.createElement('div');
  const root = createRoot(container);
  return {
    step(acc: string): void {
      // `hasNextChunk: true` enables x-markdown's streaming cache path
      // (`useStreaming`). flushSync makes each chunk a discrete synchronous
      // render, so the timing attributes the whole shipped pipeline — cache
      // update, marked re-parse to HTML, sanitisation, element construction —
      // to the chunk that triggered it.
      const el = createElement(XMarkdown, {
        content: acc,
        streaming: { hasNextChunk: true },
      });
      flushSync(() => {
        root.render(el);
      });
      // useStreaming computes its output inside a passive effect, so the
      // setStreamingOutput it calls lands AFTER this flushSync has returned and
      // is only processed by the NEXT render. Left alone, every one of up to
      // 784 chunks per trial leaves pending work behind and React's nested-
      // update counter (limit 50) trips with "Maximum update depth exceeded"
      // around chunk 52 — reproduced standalone before choosing this fix. A
      // second flushSync re-rendering the SAME element forces that pending
      // update through synchronously, which both resets the counter and makes
      // the innerHTML read below see the fully-settled output. The re-render
      // bails out on identical props (microseconds); it is part of the driver,
      // not of anything the library does.
      flushSync(() => {
        root.render(el);
      });
    },
    html: () => container.innerHTML,
    sink: () => ({
      tokens: container.querySelectorAll('*').length,
      textChars: (container.textContent ?? '').length,
    }),
    dispose(): void {
      root.unmount();
      container.remove();
    },
  };
}

/**
 * `@ant-design/x-markdown` 2.9.0: render the real component per chunk.
 *
 * Unlike `react-markdown`, this library cannot be driven without a renderer:
 * its incremental layer lives behind `useState`/`useEffect` in `useStreaming`.
 * The measured cost therefore includes React's scheduling constant for a
 * single-component tree — a stated scope difference, not a hidden one. What it
 * buys is honesty about the rest: their per-chunk work also includes a full
 * marked re-parse of the completed stream PLUS sanitisation PLUS HTML-to-
 * element conversion, none of which any internal export allows isolating.
 */
function runXMarkdown(chunks: string[]): { result: ArmResult; sink: Sink; html: string } {
  const samples: number[] = [];
  let lastSink: Sink = { tokens: 0, textChars: 0 };
  let lastHtml = '';

  for (let t = 0; t < WARMUPS + TRIALS; t++) {
    const host = createXMarkdownHost();
    let acc = '';

    const t0 = performance.now();
    for (const c of chunks) {
      acc += c;
      host.step(acc);
    }
    const elapsed = performance.now() - t0;
    if (t >= WARMUPS) samples.push(elapsed);
    // Counting happens once per trial, OUTSIDE the timed region: unlike the
    // other arms there is no cheap handle on the output during the loop, and a
    // DOM walk per chunk would add our instrumentation cost to their number.
    lastSink = host.sink();
    lastHtml = host.html();
    host.dispose();
  }

  const ms = median(samples);
  return {
    result: {
      totalMs: ms,
      perChunkUs: (ms * 1000) / chunks.length,
      samples,
      trimmedMeanMs: trimmedMean(samples),
    },
    sink: lastSink,
    html: lastHtml,
  };
}

/**
 * Characters each competitor hands to its own tokenizer across the stream.
 *
 * This is the mechanism column, and it is the reason the arms above can be
 * interpreted at all. It runs **outside** the timed loops: the instrumentation
 * is a monkey-patch, and measuring through it would put the patch's overhead
 * into the number the suite publishes.
 *
 * The entry point matters, and getting it wrong inverts the conclusion.
 * `markstream`'s public `md.stream.parse` receives the **whole accumulated
 * document** (measured 392.78x the document over a 784-chunk stream), which reads
 * as "not incremental" — but `markdown-it-ts` then re-tokenizes only a tail
 * internally, and its own stats report 783 tail reparses against 1 full parse.
 * So the tokenizer entry `md.block.parse(src, …)` is patched instead, where `src`
 * is the tail string itself.
 *
 * Each patch asserts it actually fired, because a silently-unpatched arm would
 * report 0 characters and read as infinitely efficient.
 *
 * For the 2026-08 arms: `incremark` and `x-markdown` both lex through the same
 * shared workspace copy of `marked` (see build.ts alias), so a single
 * `Lexer.prototype.lex` patch observes them exactly — instances are what
 * `marked.lexer()` itself creates, so instance-level is the safe hook.
 * `react-markdown` parses through micromark inside remark-parse; there is no
 * equivalent seam worth patching, so its characters-fed figure is computed
 * arithmetically from its documented behavior (whole document re-parsed every
 * chunk), the same way `wholeDocumentCharsLexed` is derived below.
 */
function measureCompetitorCharsFed(chunks: string[]): {
  streamdownLexChars: number;
  streamdownRemendChars: number;
  markstreamTokenizerChars: number;
  incremarkLexerChars: number;
  xmarkdownMarkedChars: number;
  reactMarkdownParseChars: number;
  streamdownPatchFired: boolean;
  markstreamPatchFired: boolean;
  incremarkPatchFired: boolean;
  xmarkdownPatchFired: boolean;
} {
  let streamdownLexChars = 0;
  let lexCalls = 0;
  {
    const holder = Lexer as unknown as {
      lex: (src: string, opts?: unknown) => unknown;
    };
    const orig = holder.lex;
    holder.lex = (src: string, opts?: unknown) => {
      streamdownLexChars += src.length;
      lexCalls++;
      return orig.call(Lexer, src, opts);
    };
    let acc = '';
    for (const c of chunks) {
      acc += c;
      parseMarkdownIntoBlocks(remend(acc));
    }
    holder.lex = orig;
  }
  // remend sees the accumulated document on every chunk, so its characters are
  // the sum of the growing prefixes.
  let streamdownRemendChars = 0;
  {
    let acc = 0;
    for (const c of chunks) {
      acc += c.length;
      streamdownRemendChars += acc;
    }
  }

  let markstreamTokenizerChars = 0;
  let blockCalls = 0;
  {
    const md = getMarkdown('chars-fed') as unknown as {
      block: {
        parse: (src: unknown, md: unknown, env: unknown, out: unknown[]) => void;
      };
    };
    const orig = md.block.parse.bind(md.block);
    md.block.parse = (src: unknown, m: unknown, env: unknown, out: unknown[]) => {
      if (typeof src === 'string') markstreamTokenizerChars += src.length;
      blockCalls++;
      return orig(src, m, env, out);
    };
    let acc = '';
    for (const c of chunks) {
      acc += c;
      parseMarkdownToStructure(acc, md as never, { final: false });
    }
    md.block.parse = orig as typeof md.block.parse;
  }

  // incremark: instance-level marked hook. Its MarkedAstBuilder constructs
  // `new Lexer(...)` per parse and calls `.lex(text)` on it, so prototype-level
  // is where every parse lands regardless of internal options plumbing.
  let incremarkLexerChars = 0;
  let incremarkLexCalls = 0;
  {
    const proto = Lexer.prototype as unknown as { lex: (src: string) => unknown };
    const orig = proto.lex;
    proto.lex = function (this: unknown, src: string) {
      if (typeof src === 'string') incremarkLexerChars += src.length;
      incremarkLexCalls++;
      return orig.call(this, src);
    };
    const parser = createIncremarkParser({ gfm: true });
    for (const c of chunks) parser.append(c);
    parser.finalize();
    proto.lex = orig;
  }

  // x-markdown: same shared-copy hook. Only its `parser.parse()` stage touches
  // marked — the useStreaming cache layer is a hand-written recognizer that
  // never lexes — so this counts exactly the whole-document re-parse cost.
  let xmarkdownMarkedChars = 0;
  let xmarkdownLexCalls = 0;
  {
    const proto = Lexer.prototype as unknown as { lex: (src: string) => unknown };
    const orig = proto.lex;
    proto.lex = function (this: unknown, src: string) {
      if (typeof src === 'string') xmarkdownMarkedChars += src.length;
      xmarkdownLexCalls++;
      return orig.call(this, src);
    };
    const host = createXMarkdownHost();
    let acc = '';
    for (const c of chunks) {
      acc += c;
      host.step(acc);
    }
    host.dispose();
    proto.lex = orig;
  }

  return {
    streamdownLexChars,
    streamdownRemendChars,
    markstreamTokenizerChars,
    incremarkLexerChars,
    xmarkdownMarkedChars,
    reactMarkdownParseChars: chunks.reduce((sum, _c, i) => sum + (i + 1) * CHUNK_CHARS, 0),
    streamdownPatchFired: lexCalls > 0,
    markstreamPatchFired: blockCalls > 0 && markstreamTokenizerChars > 0,
    incremarkPatchFired: incremarkLexCalls > 0 && incremarkLexerChars > 0,
    xmarkdownPatchFired: xmarkdownLexCalls > 0 && xmarkdownMarkedChars > 0,
  };
}

// ---------------------------------------------------------------------------
// Gates — every one of these must hold before a timing figure means anything
// ---------------------------------------------------------------------------

interface Gates {
  /** Both arms saw the same source text. */
  sameSource: boolean;
  /** Every arm actually parsed: token counts > 0. */
  bothParsed: boolean;
  /** smd's text sink received approximately the document's prose. */
  smdTextPlausible: boolean;
  /** Our arm's final token count matches a direct one-shot lex of the doc. */
  vectoFinalMatchesOneShot: boolean;
  /**
   * Our arm's final token TREE is deeply identical to a one-shot lex.
   *
   * The count gate above is not sufficient for a boundary optimisation: a
   * boundary placed one line early can split a fence, merge two paragraphs, or
   * flip a list from tight to loose while leaving the token count untouched — and
   * would then publish a fast number for a broken parse. This is the gate that
   * makes that impossible, and it is the reason a timing figure from this suite
   * can be quoted at all.
   */
  vectoTreeMatchesOneShot: boolean;
  /** The control arm agrees too, proving the comparison is like-for-like. */
  wholeDocumentMatchesOneShot: boolean;
  /** The document was actually split into more than one chunk. */
  streamed: boolean;
  /**
   * `streamdown`'s streamed block list is identical to what it produces from a
   * one-shot parse of the finished document.
   *
   * Without this, a streaming arm could look cheap by settling on a different
   * (wrong) block split than the library would produce given the whole text —
   * the same failure mode `vectoTreeMatchesOneShot` exists to catch on our side.
   */
  streamdownMatchesOneShot: boolean;
  /** `markstream`'s final node structure is identical to a one-shot parse. */
  markstreamMatchesOneShot: boolean;
  /**
   * `incremark`'s final AST after streamed append+finalize is structurally
   * identical to its own public `render()` one-shot over the whole document.
   * Position metadata is stripped before comparison (see stripPositions).
   */
  incremarkMatchesOneShot: boolean;
  /**
   * react-markdown's last streamed render (the element tree its synchronous
   * component returns for the full document) is identical to a direct one-shot
   * call on the finished document.
   */
  reactMarkdownMatchesOneShot: boolean;
  /**
   * x-markdown's final rendered innerHTML after streaming equals a fresh
   * component render of the complete document in one step.
   */
  xmarkdownMatchesOneShot: boolean;
  /**
   * Both competitor characters-fed patches actually fired.
   *
   * A monkey-patch that silently fails to install reports 0 characters, which
   * would read as a perfectly efficient parser rather than as a broken probe.
   */
  charsFedPatchesFired: boolean;
}

function evaluateGates(
  doc: string,
  chunks: string[],
  smdSinkResult: Sink,
  vectoSink: Sink,
  oldSink: Sink,
  charsFed: ReturnType<typeof measureCompetitorCharsFed>,
): Gates {
  const oneShot = marked.lexer(doc);
  // Re-drive the incremental arm once outside the timed loop to compare trees.
  // Doing it inside would put a full lex plus a deep comparison into the
  // measurement and destroy the very number this suite exists to report.
  let cache: IncrementalLexCache | null = null;
  for (const c of chunks) {
    const res = cache === null ? lexFull(c) : lexAppend(cache, c);
    cache = res.cache;
  }
  const finalTokens = cache?.tokens ?? [];

  // Re-drive each competitor once, outside the timed loops, and compare its final
  // state to a one-shot parse of the finished document.
  let sdStreamed: string[] = [];
  {
    let acc = '';
    for (const c of chunks) {
      acc += c;
      sdStreamed = parseMarkdownIntoBlocks(remend(acc));
    }
  }
  const sdOneShot = parseMarkdownIntoBlocks(doc);

  let msStreamed = '';
  {
    const md = getMarkdown('gate-stream');
    let acc = '';
    for (const c of chunks) {
      acc += c;
      msStreamed = JSON.stringify(parseMarkdownToStructure(acc, md, { final: false }));
    }
  }
  const msOneShot = JSON.stringify(
    parseMarkdownToStructure(doc, getMarkdown('gate-oneshot'), { final: true }),
  );

  // incremark gate: streamed append/finalize vs its own public render() one-shot.
  const incremarkStreamed = (() => {
    const parser = createIncremarkParser({ gfm: true });
    for (const c of chunks) parser.append(c);
    return parser.finalize();
  })();
  const incremarkOneShot = createIncremarkParser({ gfm: true }).render(doc);

  // react-markdown gate: last streamed component output vs a one-shot call.
  let rmStreamed: unknown;
  {
    let acc = '';
    for (const c of chunks) {
      acc += c;
      rmStreamed = ReactMarkdown({ children: acc, remarkPlugins: [remarkGfm] });
    }
  }
  const rmOneShot = ReactMarkdown({ children: doc, remarkPlugins: [remarkGfm] });

  // x-markdown gate: final streamed innerHTML vs a fresh one-step render.
  let xmStreamedHtml = '';
  {
    const host = createXMarkdownHost();
    let acc = '';
    for (const c of chunks) {
      acc += c;
      host.step(acc);
    }
    xmStreamedHtml = host.html();
    host.dispose();
  }
  const xmOneShotHost = createXMarkdownHost();
  xmOneShotHost.step(doc);
  const xmOneShotHtml = xmOneShotHost.html();
  xmOneShotHost.dispose();

  return {
    sameSource: chunks.join('') === doc,
    bothParsed: smdSinkResult.tokens > 0 && vectoSink.tokens > 0 && oldSink.tokens > 0,
    // smd reports text through add_text; it strips markup, so expect strictly
    // less than the raw document but a substantial fraction of it.
    smdTextPlausible:
      smdSinkResult.textChars > doc.length * 0.4 && smdSinkResult.textChars <= doc.length,
    vectoFinalMatchesOneShot: vectoSink.tokens === oneShot.length,
    vectoTreeMatchesOneShot: JSON.stringify(finalTokens) === JSON.stringify(oneShot),
    wholeDocumentMatchesOneShot: oldSink.tokens === oneShot.length,
    streamed: chunks.length > 1,
    streamdownMatchesOneShot: JSON.stringify(sdStreamed) === JSON.stringify(sdOneShot),
    markstreamMatchesOneShot: msStreamed === msOneShot,
    incremarkMatchesOneShot:
      JSON.stringify(stripPositions(incremarkStreamed.ast)) ===
      JSON.stringify(stripPositions(incremarkOneShot.ast)),
    reactMarkdownMatchesOneShot:
      JSON.stringify(rmStreamed) === JSON.stringify(rmOneShot) && rmStreamed !== undefined,
    xmarkdownMatchesOneShot: xmStreamedHtml === xmOneShotHtml && xmStreamedHtml.length > 0,
    charsFedPatchesFired:
      charsFed.streamdownPatchFired &&
      charsFed.markstreamPatchFired &&
      charsFed.incremarkPatchFired &&
      charsFed.xmarkdownPatchFired,
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

interface Row {
  sections: number;
  chars: number;
  chunks: number;
  smd: ArmResult;
  /** The current shipped strategy: `incrementalLex`, boundary-based. */
  vecto: ArmResult;
  /** The strategy this suite originally measured, kept as a control arm. */
  wholeDocument: ArmResult;
  /**
   * `streamdown` 2.5.0: remend + whole-document re-lex per chunk. Same strategy
   * class as `wholeDocument`, but a real shipped implementation rather than our
   * reproduction of one.
   */
  streamdown: ArmResult;
  /** Of `streamdown`'s time, the part spent in `remend()` rather than lexing. */
  streamdownRemendMs: number;
  /**
   * `stream-markdown-parser` 1.2.0 (markstream-vue's parser): tail reparse after
   * the last safe block boundary. Same strategy class as `vecto`.
   */
  markstream: ArmResult;
  /**
   * @incremark/core 0.3.10: persistent parser, boundary-based incremental like
   * `vecto`, with per-call definition-map/AST bookkeeping included.
   */
  incremark: ArmResult;
  /** Blocks in incremark's final AST (its output unit, for context). */
  incremarkBlocks: number;
  /** react-markdown 10.1.0: whole-document remark pipeline per chunk. */
  reactMarkdown: ArmResult;
  /** @ant-design/x-markdown 2.9.0: full component render per chunk. */
  xmarkdown: ArmResult;
  singleLex: ArmResult;
  prefixReuse: number;
  /**
   * Characters handed to `marked.lexer()` across the stream, current strategy vs
   * the old one. This is the mechanism behind the timing, reported so the number
   * can be checked rather than trusted.
   */
  charsLexed: number;
  wholeDocumentCharsLexed: number;
  /**
   * The same mechanism column for the two competitors, measured at each one's
   * real tokenizer entry point rather than its public API entry point. See
   * `measureCompetitorCharsFed` for why that distinction inverts the reading.
   */
  streamdownLexChars: number;
  /** Characters `remend()` scans across the stream — also O(document) per chunk. */
  streamdownRemendChars: number;
  markstreamTokenizerChars: number;
  /** incremark's characters handed to the shared marked lexer across the stream. */
  incremarkLexerChars: number;
  /**
   * x-markdown's characters handed to marked (its whole-document parser.parse
   * stage; its cache layer reads each chunk once and never lexes).
   */
  xmarkdownMarkedChars: number;
  /**
   * react-markdown's characters handed to remark-parse, derived arithmetically:
   * it re-parses the whole accumulated document every chunk.
   */
  reactMarkdownParseChars: number;
  /** Whether the boundary held for this document, or the instance degraded. */
  degraded: boolean;
  gates: Gates;
  gatesPass: boolean;
}

function scalingExponent(rows: Row[], pick: (r: Row) => number): number | null {
  if (rows.length < 2) return null;
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const charRatio = last.chars / first.chars;
  const timeRatio = pick(last) / pick(first);
  if (charRatio <= 1 || timeRatio <= 0) return null;
  return Math.log(timeRatio) / Math.log(charRatio);
}

async function main(): Promise<void> {
  const rows: Row[] = [];

  for (const sections of SECTION_COUNTS) {
    const doc = buildDoc(sections);
    const chunks = chunkify(doc, CHUNK_CHARS);

    const smdRun = runSmd(chunks);
    const vectoRun = runIncrementalStrategy(chunks);
    const oldRun = runWholeDocumentStrategy(chunks);
    const streamdownRun = runStreamdown(chunks);
    const markstreamRun = runMarkstream(chunks);
    const incremarkRun = runIncremark(chunks);
    const reactMarkdownRun = runReactMarkdown(chunks);
    const xmarkdownRun = runXMarkdown(chunks);
    const singleLex = runSingleLex(doc);

    // Outside every timed loop: this installs monkey-patches, so timing through
    // it would publish the probe's overhead as the library's cost.
    const charsFed = measureCompetitorCharsFed(chunks);

    const gates = evaluateGates(doc, chunks, smdRun.sink, vectoRun.sink, oldRun.sink, charsFed);
    const gatesPass = Object.values(gates).every(Boolean);

    rows.push({
      sections,
      chars: doc.length,
      chunks: chunks.length,
      smd: smdRun.result,
      vecto: vectoRun.result,
      wholeDocument: oldRun.result,
      streamdown: streamdownRun.result,
      streamdownRemendMs: streamdownRun.remendOnlyMs,
      markstream: markstreamRun.result,
      incremark: incremarkRun.result,
      incremarkBlocks: incremarkRun.blocks,
      reactMarkdown: reactMarkdownRun.result,
      xmarkdown: xmarkdownRun.result,
      singleLex,
      prefixReuse: vectoRun.prefixReuse,
      charsLexed: vectoRun.charsLexed,
      streamdownLexChars: charsFed.streamdownLexChars,
      streamdownRemendChars: charsFed.streamdownRemendChars,
      markstreamTokenizerChars: charsFed.markstreamTokenizerChars,
      incremarkLexerChars: charsFed.incremarkLexerChars,
      xmarkdownMarkedChars: charsFed.xmarkdownMarkedChars,
      reactMarkdownParseChars: charsFed.reactMarkdownParseChars,
      // What the old arm handed the lexer: every chunk saw the whole accumulated
      // document, so this is the sum of the growing prefix lengths.
      wholeDocumentCharsLexed: chunks.reduce((sum, _c, i) => sum + (i + 1) * CHUNK_CHARS, 0),
      degraded: vectoRun.degraded,
      gates,
      gatesPass,
    });
  }

  const allGatesPass = rows.every((r) => r.gatesPass);

  // The server names the result file `<name>-<engine>.json`. Omitting `engine`
  // makes every run write `run-unknown.json`, so the second browser silently
  // overwrites the first and the runner never sees a new file — it then waits out
  // its full timeout on a run that already finished. Derive it from the UA, as
  // layout-flex-canvas-ui does.
  const engineName = /firefox/i.test(navigator.userAgent) ? 'firefox' : 'chrome';

  const payload = {
    suite: 'stream-markdown-smd',
    name: 'run',
    engine: engineName,
    userAgent: navigator.userAgent,
    note:
      'Streaming-parse cost only. The `vecto` arm imports incrementalLex from ' +
      'the shipped package source, so it measures what production runs; ' +
      '`wholeDocument` is the strategy this suite originally measured, kept as ' +
      'a same-process control arm for the before/after. smd is a true ' +
      'incremental parser. All arms use an identical counting sink, so none ' +
      'pays for rendering. smd implements a reduced CommonMark subset and does ' +
      'no layout/canvas/a11y/math work — see the header comment for the full ' +
      'scope statement. Note the workload is prose: documents containing ' +
      'display math or link reference definitions degrade to whole-document ' +
      'lexing by design, and the `degraded` field per row reports which path ran. ' +
      'The `streamdown` arm measures remend + whole-document block splitting, NOT ' +
      'its per-block remark/React stage, which is block-memoised and therefore ' +
      'incremental; the `markstream` arm measures stream-markdown-parser with no ' +
      'Vue involved at all, and produces a full node structure per chunk where our ' +
      'arm produces tokens, so it does strictly more per call. Characters-fed for ' +
      "both competitors is measured at each one's real tokenizer entry point " +
      '(marked Lexer.lex, markdown-it-ts md.block.parse), not its public API ' +
      "entry point: markstream's stream.parse receives the whole accumulated " +
      'document but internally re-tokenizes only a tail, so the API-level figure ' +
      'would misreport a boundary parser as a whole-document one. The 2026-08 ' +
      'arms: incremark is driven at its public append/finalize API and includes ' +
      'its per-call definition-map and aggregate-AST rebuilds; react-markdown ' +
      'is its synchronous Markdown component called directly per chunk over the ' +
      'whole accumulated document (whole remark pipeline plus hast-to-element ' +
      'conversion; React reconciliation and DOM commit outside); x-markdown is ' +
      'the real component rendered per chunk through flushSync, so its cache ' +
      'layer, full marked re-parse, sanitisation and element construction are ' +
      'all inside, and React scheduling for a single-component tree is a stated ' +
      'overhead. All marked-based arms lex through the same workspace marked ' +
      'copy (bundle alias), so engine constants cannot masquerade as strategy ' +
      'differences. FluidMarkdown (native mobile) and react-native-streamdown ' +
      '(React Native port; web twin already measured) cannot run this axis and ' +
      'are excluded with reasons in comparisons/README.md.',
    chunkChars: CHUNK_CHARS,
    trials: TRIALS,
    warmups: WARMUPS,
    crossOriginIsolated: globalThis.crossOriginIsolated ?? false,
    allGatesPass,
    // Suppress every timing row unless all gates hold, so a broken run cannot
    // be quoted by accident. Same discipline as layout-flex-canvas-ui.
    rows: allGatesPass ? rows : [],
    gateFailures: allGatesPass ? [] : rows.filter((r) => !r.gatesPass).map((r) => r.gates),
    scaling: allGatesPass
      ? {
          smdExponent: scalingExponent(rows, (r) => r.smd.totalMs),
          vectoStrategyExponent: scalingExponent(rows, (r) => r.vecto.totalMs),
          wholeDocumentExponent: scalingExponent(rows, (r) => r.wholeDocument.totalMs),
          // The claim the streamdown arm exists to test: does a real shipped
          // implementation of the whole-document strategy land on the same
          // exponent as our reproduction of it? If it does, `wholeDocument` is
          // validated as a fair model rather than a straw man.
          streamdownExponent: scalingExponent(rows, (r) => r.streamdown.totalMs),
          streamdownRemendExponent: scalingExponent(rows, (r) => r.streamdownRemendMs),
          markstreamExponent: scalingExponent(rows, (r) => r.markstream.totalMs),
          incremarkExponent: scalingExponent(rows, (r) => r.incremark.totalMs),
          reactMarkdownExponent: scalingExponent(rows, (r) => r.reactMarkdown.totalMs),
          xmarkdownExponent: scalingExponent(rows, (r) => r.xmarkdown.totalMs),
          singleLexExponent: scalingExponent(rows, (r) => r.singleLex.totalMs),
          // The exponent is the claim this suite makes, so it is reported for the
          // characters handed to the lexer as well as for wall time. Wall time
          // alone can move for reasons unrelated to the strategy; the two
          // agreeing is what makes the attribution sound.
          vectoCharsLexedExponent: scalingExponent(rows, (r) => r.charsLexed),
          streamdownLexCharsExponent: scalingExponent(rows, (r) => r.streamdownLexChars),
          markstreamTokenizerCharsExponent: scalingExponent(
            rows,
            (r) => r.markstreamTokenizerChars,
          ),
          incremarkLexerCharsExponent: scalingExponent(rows, (r) => r.incremarkLexerChars),
          xmarkdownMarkedCharsExponent: scalingExponent(rows, (r) => r.xmarkdownMarkedChars),
          reactMarkdownParseCharsExponent: scalingExponent(rows, (r) => r.reactMarkdownParseChars),
        }
      : null,
    versions: {
      smd: '0.2.15',
      streamdown: '2.5.0',
      remend: '1.3.0',
      streamMarkdownParser: '1.2.0',
      markdownItTs: '1.0.7',
      incremark: '0.3.10',
      reactMarkdown: '10.1.0',
      remarkGfm: '4.0.1',
      antDesignXMarkdown: '2.9.0',
      react: '19.2.8',
      marked: (marked as unknown as { defaults?: unknown }) ? 'see package.json' : 'unknown',
    },
  };

  await fetch('/results', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

void main();
