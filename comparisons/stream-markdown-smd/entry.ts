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
 * What *is* ours is the **strategy**: the worker
 * (`packages/markdown/src/MarkdownWorkerSource.ts`) caches the accumulated
 * source per instance, appends each delta, then calls `marked.lexer()` on the
 * **whole document again**, and returns only the changed token tail via a
 * raw-string prefix match. `smd` instead advances a persistent parser state
 * machine over just the new chunk and never revisits earlier text.
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
import { marked } from 'marked';
import * as smd from 'streaming-markdown';

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
 * Our strategy: accumulate the source and re-lex the whole document per chunk,
 * exactly as `MarkdownWorkerSource` does, including the raw-prefix match that
 * decides how much of the token array is reused.
 */
function runVectoStrategy(chunks: string[]): {
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
    // Fraction of token slots the delta protocol successfully reused. This is
    // the part that IS ours, and it is high — the strategy saves entity
    // rebuilds, it just cannot save lexing.
    prefixReuse: totalConsidered === 0 ? 0 : prefixMatchedTotal / totalConsidered,
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

// ---------------------------------------------------------------------------
// Gates — every one of these must hold before a timing figure means anything
// ---------------------------------------------------------------------------

interface Gates {
  /** Both arms saw the same source text. */
  sameSource: boolean;
  /** Both arms actually parsed: token counts > 0. */
  bothParsed: boolean;
  /** smd's text sink received approximately the document's prose. */
  smdTextPlausible: boolean;
  /** Our arm's final token count matches a direct one-shot lex of the doc. */
  vectoFinalMatchesOneShot: boolean;
  /** The document was actually split into more than one chunk. */
  streamed: boolean;
}

function evaluateGates(doc: string, chunks: string[], smdSinkResult: Sink, vectoSink: Sink): Gates {
  const oneShotTokens = marked.lexer(doc).length;
  return {
    sameSource: chunks.join('') === doc,
    bothParsed: smdSinkResult.tokens > 0 && vectoSink.tokens > 0,
    // smd reports text through add_text; it strips markup, so expect strictly
    // less than the raw document but a substantial fraction of it.
    smdTextPlausible:
      smdSinkResult.textChars > doc.length * 0.4 && smdSinkResult.textChars <= doc.length,
    vectoFinalMatchesOneShot: vectoSink.tokens === oneShotTokens,
    streamed: chunks.length > 1,
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
  vecto: ArmResult;
  singleLex: ArmResult;
  prefixReuse: number;
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
    const vectoRun = runVectoStrategy(chunks);
    const singleLex = runSingleLex(doc);

    const gates = evaluateGates(doc, chunks, smdRun.sink, vectoRun.sink);
    const gatesPass = Object.values(gates).every(Boolean);

    rows.push({
      sections,
      chars: doc.length,
      chunks: chunks.length,
      smd: smdRun.result,
      vecto: vectoRun.result,
      singleLex,
      prefixReuse: vectoRun.prefixReuse,
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
      'Streaming-parse cost only. Our arm is marked.lexer() driven by the ' +
      'delta strategy from MarkdownWorkerSource; smd is a true incremental ' +
      'parser. Both use an identical counting sink, so neither pays for ' +
      'rendering. smd implements a reduced CommonMark subset and does no ' +
      'layout/canvas/a11y/math work — see the header comment for the full ' +
      'scope statement.',
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
          singleLexExponent: scalingExponent(rows, (r) => r.singleLex.totalMs),
        }
      : null,
    versions: {
      smd: '0.2.15',
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
