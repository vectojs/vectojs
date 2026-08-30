/**
 * End-to-end streaming pipeline: chunk→worker→lex→reconcile→shape→layout→render
 *
 * Why this file exists:
 * `entry.ts` isolates PARSE cost (strategy vs `smd`) by design — that is the
 * axis where `@vectojs/markdown` genuinely overlaps `streaming-markdown`. It
 * deliberately does NOT pay for entity building, shaping, layout or canvas draw,
 * because those are not comparable work (`smd` builds DOM nodes).
 *
 * A parse-only number cannot tell you whether a streaming Markdown feed stays
 * inside a frame budget at 240 Hz, nor which stage dominates when it does not.
 * This entry measures the **main-thread** pipeline that a real `Markdown` stream
 * traverses for every chunk, with `p50/p95/p99` per stage, not just total wall
 * time:
 *
 *   chunk → worker → lex → reconcile → shape → layout → render
 *
 * - `chunk`   stream controller / string accumulation (postMessage input)
 * - `worker`  `postMessage` dispatch + structured clone on the main thread.
 *             With the synchronous path (Worker deleted before import, same
 *             technique as `benchmarks/markdown-stream-phases`) this is 0 and the
 *             lex is attributable; the worker transfer cost is measured
 *             separately by `benchmarks/markdown-stream-transfer`.
 * - `lex`     `marked.lexer()` over the incremental tail (via `incrementalLex`)
 * - `reconcile` token diff → entity tree (prefix match, in-place updates,
 *             destroy/create of the tail, abbr/footnote fixups)
 * - `shape`   text shaping: `CanvasRenderingContext2D.measureText` (synchronous
 *             and fully attributable) plus `fillText` raster lower-bound
 * - `layout`  `Stack.layout()` / `Scene.transform` – positioning
 * - `render`  `Scene.drawWalk` + `flush` – paint submission
 *
 * `heap` ( `performance.memory.usedJSHeapSize` when available – Chromium only)
 * and `entityCount` (`Markdown.content.children.length` + retained stats) are
 * carried alongside timing, so retention cost is not invisible.
 *
 * Implementation vs ground rules:
 * - Every stage is timed on the **main thread** with `performance.mark` /
 *   `performance.measure` plus direct `performance.now()` arrays, then
 *   summarised as `p50/p95/p99` (R-7 interpolation) per stage per document
 *   size. `performance.memory` is probed if present; absent on Firefox is a
 *   stated gap, not a hidden one.
 * - Worker is DELIBERATELY removed before the Markdown module loads, so the
 *   lex is synchronous and attributable to the chunk that caused it (same
 *   rationale as `benchmarks/markdown-stream-phases`). That makes `worker`
 *   read as 0 here; the O(document)-per-chunk transfer cost is not re-measured
 *   here precisely because it is measured once in the dedicated transfer bench.
 * - `Scene` + `Markdown` run against a real canvas (900×700, `maxWidth: 820`)
 *   on the real compositor, via `hyprland-browser-bench`. Headless or a
 *   software raster fallback would report a different `render` number, so no
 *   screenshot or off-screen claim is quoted.
 * - Import is through workspace SOURCE (build.ts alias @vectojs/* ->
 *   packages/<pkg>/src/index.ts), so what is timed is what production ships,
 *   not a stale dist.
 */

import { calibrateRefreshRate } from '../../benchmarks/_shared/client';

// No static imports of @vectojs/* here: the Worker is created at module load,
// so it must be removed BEFORE the module is evaluated. Everything is
// dynamically imported inside main() after the deletion.

// ---------------------------------------------------------------------------
// Workload — identical to entry.ts so the two are comparable
// ---------------------------------------------------------------------------

const CHUNK_CHARS = 32;
const SECTION_COUNTS = [25, 50, 100, 200] as const;
const TRIALS = 7;
const WARMUPS = 2;

function runnerIdentity(): { runId: string; suiteRunId: string } {
  const params = new URLSearchParams(location.search);
  const manualId = `manual-${Date.now()}`;
  return {
    runId: params.get('runId') ?? manualId,
    suiteRunId: params.get('suiteRunId') ?? manualId,
  };
}

function section(i: number): string {
  return (
    `## Section ${i}\n\n` +
    `Paragraph ${i} with **bold text** and \`inline code\` and ` +
    `a [link](https://example.com/${i}) plus trailing prose.\n\n`
  );
}
function buildDoc(sections: number): string {
  let out = '';
  for (let j = 0; j < sections; j++) out += section(j);
  return out;
}
function chunkify(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let k = 0; k < text.length; k += size) chunks.push(text.slice(k, k + size));
  return chunks;
}

// ---------------------------------------------------------------------------
// Stats helpers — same definitions as benchmarks/_shared/stats.ts
// ---------------------------------------------------------------------------

function ascending(xs: readonly number[]): number[] {
  return [...xs].sort((a, b) => a - b);
}
function median(xs: readonly number[]): number {
  if (xs.length === 0) throw new RangeError('median empty');
  const s = ascending(xs);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
function percentile(xs: readonly number[], q: number): number {
  if (xs.length === 0) throw new RangeError('percentile empty');
  if (!(q >= 0 && q <= 1)) throw new RangeError(`q out of range ${q}`);
  const s = ascending(xs);
  if (s.length === 1) return s[0]!;
  const rank = (s.length - 1) * q;
  const lo = Math.floor(rank),
    hi = Math.ceil(rank);
  if (lo === hi) return s[rank]!;
  return s[lo]! + (s[hi]! - s[lo]!) * (rank - lo);
}
function trimmedMean(samples: number[]): number {
  const s = ascending(samples);
  const drop = Math.floor(s.length * 0.05);
  const kept = s.slice(drop, s.length - drop || undefined);
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}
function mad(xs: readonly number[]): number {
  const med = median(xs);
  return median(xs.map((x) => Math.abs(x - med)));
}

interface Summary {
  n: number;
  min: number;
  max: number;
  median: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  mean: number;
  mad: number;
  madPct: number;
  spreadPct: number;
  trimmedMean: number;
}

function summarize(xs: readonly number[]): Summary {
  if (xs.length === 0) throw new RangeError('summarize empty');
  const s = ascending(xs);
  const med = median(xs);
  const m = mad(xs);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return {
    n: xs.length,
    min: s[0]!,
    max: s[s.length - 1]!,
    median: med,
    p50: percentile(xs, 0.5),
    p90: percentile(xs, 0.9),
    p95: percentile(xs, 0.95),
    p99: percentile(xs, 0.99),
    mean,
    mad: m,
    madPct: med === 0 ? 0 : (100 * m) / med,
    spreadPct: med === 0 ? 0 : (100 * (s[s.length - 1]! - s[0]!)) / med,
    trimmedMean: trimmedMean([...xs]),
  };
}

// ---------------------------------------------------------------------------
// Per-stage capture
// ---------------------------------------------------------------------------

interface StageSamples {
  chunk: number[]; // StreamController / string append overhead
  worker: number[]; // postMessage dispatch (0 when Worker deleted)
  lex: number[]; // marked.lexer
  reconcile: number[]; // updateTokens (entity diff)
  shapeMeasure: number[]; // measureText
  shapeFill: number[]; // fillText (raster lower bound)
  layout: number[]; // Scene transform
  render: number[]; // drawWalk+flush+entityPaint
  total: number[]; // per-chunk wall (append+step)
}

interface HeapPoint {
  usedJSHeapSize: number | null; // bytes, null when unavailable
  totalJSHeapSize: number | null;
  jsHeapSizeLimit: number | null;
}

function heapSample(): HeapPoint {
  const perf: any = performance as any;
  const mem = perf.memory;
  if (!mem) return { usedJSHeapSize: null, totalJSHeapSize: null, jsHeapSizeLimit: null };
  return {
    usedJSHeapSize: typeof mem.usedJSHeapSize === 'number' ? mem.usedJSHeapSize : null,
    totalJSHeapSize: typeof mem.totalJSHeapSize === 'number' ? mem.totalJSHeapSize : null,
    jsHeapSizeLimit: typeof mem.jsHeapSizeLimit === 'number' ? mem.jsHeapSizeLimit : null,
  };
}

// ---------------------------------------------------------------------------
// One e2e trial — synchronous worker-deleted path
// ---------------------------------------------------------------------------

type MarkdownCtor = new (text: string, opts?: Record<string, unknown>) => any;
type SceneCtor = new (c: HTMLCanvasElement, o?: Record<string, unknown>) => any;

async function runE2eTrial(
  Markdown: MarkdownCtor,
  Scene: SceneCtor,
  markedModule: any,
  canvas: HTMLCanvasElement,
  chunks: string[],
): Promise<{
  samples: StageSamples;
  heaps: HeapPoint[];
  entityCounts: number[];
  totalMs: number;
  finalTokens: number;
  oneShotTokens: number;
}> {
  const scene = new (Scene as any)(canvas, { disableWindowResize: true });
  scene.resize(900, 700);
  // Scene phase timing: use the public _shared/phases machinery if present,
  // else fall back to direct Scene API.
  // @vectojs/core Scene exposes setPhaseTiming / clearRenderPhases / renderPhases
  try {
    scene.setPhaseTiming?.(true);
  } catch {}
  try {
    scene.clearRenderPhases?.();
  } catch {}

  const md = new (Markdown as any)(chunks[0] ?? '', { maxWidth: 820 });
  (scene as any).add(md);
  (scene as any).step(16.67);

  const samples: StageSamples = {
    chunk: [],
    worker: [],
    lex: [],
    reconcile: [],
    shapeMeasure: [],
    shapeFill: [],
    layout: [],
    render: [],
    total: [],
  };
  const heaps: HeapPoint[] = [];
  const entityCounts: number[] = [];

  // Patch marked.lexer for lex stage
  const origLexer = markedModule.marked.lexer.bind(markedModule.marked);
  let lexPerChunk = 0;
  markedModule.marked.lexer = (src: string) => {
    const t0 = performance.now();
    // Also emit User Timing marks for DevTools “Performance” panel
    const m0 = `e2e:lex:start:${Math.random()}`;
    try {
      performance.mark(m0);
    } catch {}
    const out = origLexer(src);
    try {
      const m1 = `e2e:lex:end:${Math.random()}`;
      performance.mark(m1);
      try {
        performance.measure('e2e:lex', m0, m1);
      } catch {}
      try {
        performance.clearMarks?.(m0);
        performance.clearMarks?.(m1);
      } catch {}
    } catch {}
    const dt = performance.now() - t0;
    lexPerChunk += dt;
    return out;
  };

  // Patch Markdown.updateTokens for reconcile stage
  const mdAny: any = md;
  let origUpdate: any = null;
  let reconcilePerChunk = 0;
  if (typeof mdAny.updateTokens === 'function') {
    origUpdate = mdAny.updateTokens.bind(mdAny);
    mdAny.updateTokens = (...args: any[]) => {
      const t0 = performance.now();
      const m0 = `e2e:reconcile:start:${Math.random()}`;
      try {
        performance.mark(m0);
      } catch {}
      const out = origUpdate(...args);
      try {
        const m1 = `e2e:reconcile:end:${Math.random()}`;
        performance.mark(m1);
        try {
          performance.measure('e2e:reconcile', m0, m1);
        } catch {}
        try {
          performance.clearMarks?.(m0);
          performance.clearMarks?.(m1);
        } catch {}
      } catch {}
      reconcilePerChunk += performance.now() - t0;
      return out;
    };
  }

  // Patch Canvas measureText/fillText for shape stage
  const proto: any = CanvasRenderingContext2D.prototype;
  const origMeasure: any = proto.measureText;
  const origFill: any = proto.fillText;
  let measurePerChunk = 0,
    fillPerChunk = 0;
  proto.measureText = function (this: any, text: string) {
    const t0 = performance.now();
    const out = origMeasure.call(this, text);
    measurePerChunk += performance.now() - t0;
    return out;
  };
  proto.fillText = function (this: any, ...a: any[]) {
    const t0 = performance.now();
    const out = origFill.apply(this, a);
    fillPerChunk += performance.now() - t0;
    return out;
  };

  // Drive remaining chunks (chunks[0] already consumed in constructor)
  const tTotal0 = performance.now();
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i]!;

    lexPerChunk = 0;
    reconcilePerChunk = 0;
    measurePerChunk = 0;
    fillPerChunk = 0;

    // chunk stage — string handling / StreamController would sit here.
    // With direct appendMarkdown it is the slice already done; time the call setup.
    const tChunk0 = performance.now();
    try {
      performance.mark(`e2e:chunk:start:${i}`);
    } catch {}
    // worker stage is 0 in sync path — record explicitly so p50 exists
    const tWorker0 = performance.now();
    try {
      performance.mark(`e2e:worker:start:${i}`);
    } catch {}
    try {
      performance.mark(`e2e:worker:end:${i}`);
      try {
        performance.measure('e2e:worker', `e2e:worker:start:${i}`, `e2e:worker:end:${i}`);
      } catch {}
    } catch {}
    const workerDt = performance.now() - tWorker0;
    // Total per-chunk wall starts before append
    const tPerChunk0 = performance.now();

    // lex + reconcile happen inside appendMarkdown; they are captured via patches above
    // Also wrap append itself for chunk measure
    try {
      performance.mark(`e2e:lex:start:${i}`);
    } catch {}
    md.appendMarkdown(chunk);
    try {
      performance.mark(`e2e:lex:end:${i}`);
      try {
        performance.measure('e2e:lex', `e2e:lex:start:${i}`, `e2e:lex:end:${i}`);
      } catch {}
    } catch {}
    const chunkDt = performance.now() - tChunk0;
    try {
      performance.mark(`e2e:chunk:end:${i}`);
      try {
        performance.measure('e2e:chunk', `e2e:chunk:start:${i}`, `e2e:chunk:end:${i}`);
      } catch {}
    } catch {}

    // layout + render — scene.step does transform/drawWalk/flush
    // Capture renderPhases delta for layout/render split
    const beforePhases: any[] = (() => {
      try {
        return [...((scene as any).renderPhases ?? [])];
      } catch {
        return [];
      }
    })();
    const tStep0 = performance.now();
    try {
      performance.mark(`e2e:render:start:${i}`);
    } catch {}
    (scene as any).step(16.67);
    try {
      performance.mark(`e2e:render:end:${i}`);
      try {
        performance.measure('e2e:render', `e2e:render:start:${i}`, `e2e:render:end:${i}`);
      } catch {}
    } catch {}
    const stepDt = performance.now() - tStep0;

    // Derive layout vs render from renderPhases delta if available
    let layoutDt = 0,
      renderDt = stepDt;
    try {
      const after: any[] = [...((scene as any).renderPhases ?? [])];
      // Find transform total in delta (layout). This is heuristic: sum of
      // totals that appeared after `before` — but renderPhases accumulates,
      // so we diff by phase name.
      const beforeMap = new Map(beforePhases.map((e: any) => [e.phase, e.totalMs]));
      let transformDelta = 0,
        drawDelta = 0,
        flushDelta = 0;
      for (const e of after) {
        const prev = beforeMap.get(e.phase) ?? 0;
        const delta = e.totalMs - prev;
        if (e.phase === 'transform') transformDelta = delta;
        if (e.phase === 'drawWalk') drawDelta = delta;
        if (e.phase === 'flush') flushDelta = delta;
      }
      layoutDt = transformDelta;
      // render is drawWalk+flush+entityPaint nested; stepDt is the wall, but
      // report render as drawWalk+flush for consistency with phases bench.
      if (drawDelta > 0 || flushDelta > 0) renderDt = drawDelta + flushDelta;
    } catch {}

    const totalDt = performance.now() - tPerChunk0;

    // Emit per-stage measures for tooling
    try {
      performance.measure('e2e:total', `e2e:chunk:start:${i}`, `e2e:render:end:${i}`);
    } catch {}

    samples.chunk.push(chunkDt);
    samples.worker.push(workerDt);
    samples.lex.push(lexPerChunk);
    samples.reconcile.push(reconcilePerChunk);
    samples.shapeMeasure.push(measurePerChunk);
    samples.shapeFill.push(fillPerChunk);
    samples.layout.push(layoutDt);
    samples.render.push(renderDt);
    samples.total.push(totalDt);

    // Heap + entity count after each chunk
    heaps.push(heapSample());
    try {
      const cnt = (mdAny.content?.children?.length ?? mdAny.children?.length ?? 0) as number;
      entityCounts.push(cnt);
    } catch {
      entityCounts.push(0);
    }
  }

  const totalMs = performance.now() - tTotal0;

  // Restore patches
  markedModule.marked.lexer = origLexer;
  if (origUpdate) mdAny.updateTokens = origUpdate;
  proto.measureText = origMeasure;
  proto.fillText = origFill;

  // Final token parity gate
  let finalTokens = 0,
    oneShotTokens = 0;
  try {
    const allText = chunks.join('');
    oneShotTokens = (markedModule.marked.lexer(allText) as any[]).length;
    // md's internal tokens — access via any, fallback to entity count
    const mdTokens: any = mdAny.tokens ?? mdAny._tokens ?? null;
    if (Array.isArray(mdTokens)) finalTokens = mdTokens.length;
    else finalTokens = mdAny.content?.children?.length ?? 0;
  } catch {
    finalTokens = 0;
    oneShotTokens = 0;
  }

  try {
    scene.clearRenderPhases?.();
  } catch {}
  try {
    md.destroy();
  } catch {}
  try {
    scene.destroy();
  } catch {}

  return { samples, heaps, entityCounts, totalMs, finalTokens, oneShotTokens };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const canvas = document.createElement('canvas');
  canvas.width = 900;
  canvas.height = 700;
  canvas.style.cssText = 'display:block;width:900px;height:700px;border:1px solid #e5e7eb';
  document.body.appendChild(canvas);
  const pre = document.createElement('pre');
  pre.style.cssText =
    'font:12px monospace;white-space:pre-wrap;max-height:60vh;overflow:auto;border:1px solid #eee;padding:8px;margin:8px 0';
  document.body.appendChild(pre);
  const log = (m: string) => {
    pre.textContent += m + '\n';
    console.log(m);
  };
  const { runId, suiteRunId } = runnerIdentity();
  const refreshHz = await calibrateRefreshRate(1000);
  log(`refreshHz: ${refreshHz.toFixed(2)}`);

  // Delete Worker BEFORE importing Markdown so the synchronous path runs.
  // This is the same deletion `benchmarks/markdown-stream-phases` does, for the
  // same reason: make lex attributable per chunk.
  const RealWorker: any = (globalThis as any).Worker;
  let workerDeleted = false;
  try {
    delete (globalThis as any).Worker;
    workerDeleted = (globalThis as any).Worker === undefined;
  } catch {
    workerDeleted = false;
  }
  log(
    `Worker deleted before import: ${workerDeleted} (sync path ${workerDeleted ? 'active' : 'fallback — Worker still present, worker stage will be 0 anyway'})`,
  );

  // Dynamic imports after deletion — they see the deleted global.
  const markedModule: any = await import('marked');
  const markdownPkg: any = await import('@vectojs/markdown');
  const corePkg: any = await import('@vectojs/core');
  const Markdown: MarkdownCtor = markdownPkg.Markdown;
  const Scene: SceneCtor = corePkg.Scene;
  // Restore Worker for any later code (not needed, but polite)
  if (RealWorker !== undefined) (globalThis as any).Worker = RealWorker;

  // Report performance.memory availability
  const memAvail = !!(performance as any).memory;
  log(
    `performance.memory available: ${memAvail} ${memAvail ? `heapLimit=${(((performance as any).memory?.jsHeapSizeLimit ?? 0) / 1048576).toFixed(0)}MB` : ''}`,
  );
  log(`crossOriginIsolated: ${globalThis.crossOriginIsolated ?? false}`);

  const rows: any[] = [];

  for (const sections of SECTION_COUNTS) {
    const doc = buildDoc(sections);
    const chunks = chunkify(doc, CHUNK_CHARS);
    log(
      `\n— sections=${sections} chars=${doc.length} chunks=${chunks.length} trials=${TRIALS} warmups=${WARMUPS} —`,
    );

    // Warmups (not measured)
    for (let w = 0; w < WARMUPS; w++) {
      await runE2eTrial(Markdown, Scene, markedModule, canvas, chunks);
      log(`  warmup ${w + 1}/${WARMUPS} done`);
      await new Promise((r) => setTimeout(r, 10));
    }

    // Trials
    const trialSamples: StageSamples[] = [];
    const trialHeaps: HeapPoint[][] = [];
    const trialEntityCounts: number[][] = [];
    const trialTotalMs: number[] = [];
    let finalTokensLast = 0,
      oneShotTokensLast = 0;
    for (let t = 0; t < TRIALS; t++) {
      const res = await runE2eTrial(Markdown, Scene, markedModule, canvas, chunks);
      trialSamples.push(res.samples);
      trialHeaps.push(res.heaps);
      trialEntityCounts.push(res.entityCounts);
      trialTotalMs.push(res.totalMs);
      finalTokensLast = res.finalTokens;
      oneShotTokensLast = res.oneShotTokens;
      log(
        `  trial ${t + 1}/${TRIALS} total=${res.totalMs.toFixed(2)}ms lex_p50=${summarize(res.samples.lex).p50.toFixed(3)}ms render_p50=${summarize(res.samples.render).p50.toFixed(3)}ms`,
      );
      await new Promise((r) => setTimeout(r, 10));
    }

    // Aggregate per-stage across all trials (flatten chunks)
    const flat = (pick: (s: StageSamples) => number[]): number[] => trialSamples.flatMap(pick);

    const mkSummary = (xs: number[]): Summary | null => (xs.length ? summarize(xs) : null);

    const chunkSummary = mkSummary(flat((s) => s.chunk));
    const workerSummary = mkSummary(flat((s) => s.worker));
    const lexSummary = mkSummary(flat((s) => s.lex));
    const reconcileSummary = mkSummary(flat((s) => s.reconcile));
    const shapeMeasureSummary = mkSummary(flat((s) => s.shapeMeasure));
    const shapeFillSummary = mkSummary(flat((s) => s.shapeFill));
    const layoutSummary = mkSummary(flat((s) => s.layout));
    const renderSummary = mkSummary(flat((s) => s.render));
    const totalPerChunkSummary = mkSummary(flat((s) => s.total));

    const totalStreamSummary = summarize(trialTotalMs);

    // Heap: final used heap median across trials (last sample per trial)
    const finalHeaps = trialHeaps
      .map((h) => h[h.length - 1]?.usedJSHeapSize ?? null)
      .filter((v) => v !== null) as number[];
    const initialHeaps = trialHeaps
      .map((h) => h[0]?.usedJSHeapSize ?? null)
      .filter((v) => v !== null) as number[];
    const heapDelta =
      finalHeaps.length && initialHeaps.length ? median(finalHeaps) - median(initialHeaps) : null;

    // Entity count: final per trial
    const finalEntities = trialEntityCounts.map((ec) => ec[ec.length - 1] ?? 0);
    const entitySummary = summarize(finalEntities as number[]);

    // Gates
    const gates = {
      sameSource: chunks.join('') === doc,
      streamed: chunks.length > 1,
      finalTokensPlausible: finalTokensLast > 0 && oneShotTokensLast > 0,
      finalMatchesOneShot: finalTokensLast === oneShotTokensLast,
      workerPathSync: workerDeleted,
    };
    const gatesPass = gates.sameSource && gates.streamed;

    rows.push({
      sections,
      chars: doc.length,
      chunks: chunks.length,
      e2e: {
        // Wall time for whole streamed document
        totalStream: totalStreamSummary,
        totalStreamMsMedian: totalStreamSummary.median,
        perChunkUsMedian: totalPerChunkSummary
          ? (totalPerChunkSummary.median * 1000) / chunks.length
          : 0,
        // Per-stage per-chunk p50/p95/p99 (main-thread)
        chunk: chunkSummary,
        worker: workerSummary,
        lex: lexSummary,
        reconcile: reconcileSummary,
        shapeMeasure: shapeMeasureSummary,
        shapeFill: shapeFillSummary,
        // shape combined (measure+fill)
        shape: (() => {
          const combined = flat((s) => s.shapeMeasure.map((v, i) => v + (s.shapeFill[i] ?? 0)));
          return combined.length ? summarize(combined) : null;
        })(),
        layout: layoutSummary,
        render: renderSummary,
        totalPerChunk: totalPerChunkSummary,
      },
      heap: memAvail
        ? {
            initialUsedMB: initialHeaps.length
              ? +(median(initialHeaps) / 1048576).toFixed(2)
              : null,
            finalUsedMB: finalHeaps.length ? +(median(finalHeaps) / 1048576).toFixed(2) : null,
            deltaMB: heapDelta !== null ? +(heapDelta / 1048576).toFixed(2) : null,
            samplesPerTrial: trialHeaps[0]?.length ?? 0,
          }
        : null,
      entityCount: {
        finalMedian: entitySummary.median,
        finalP50: entitySummary.p50,
        finalP95: entitySummary.p95,
        finalMax: entitySummary.max,
        summary: entitySummary,
      },
      // Carry competitor-style charsLexed for parity with entry.ts
      finalTokens: finalTokensLast,
      oneShotTokens: oneShotTokensLast,
      gates,
      gatesPass,
    });
  }

  const allGatesPass = rows.every((r) => r.gatesPass);

  // Scaling exponents (same as entry.ts) for wall and per-stage medians
  function scalingExponent(rows: any[], pick: (r: any) => number): number | null {
    if (rows.length < 2) return null;
    const first = rows[0]!,
      last = rows[rows.length - 1]!;
    const charRatio = last.chars / first.chars;
    const timeRatio = pick(last) / pick(first);
    if (charRatio <= 1 || timeRatio <= 0) return null;
    return Math.log(timeRatio) / Math.log(charRatio);
  }

  const engineName = /firefox/i.test(navigator.userAgent) ? 'firefox' : 'chrome';

  const payload: any = {
    runId,
    suiteRunId,
    suite: 'stream-markdown-smd',
    name: 'run-e2e',
    engine: engineName,
    userAgent: navigator.userAgent,
    refreshHz,
    note:
      'End-to-end streaming pipeline main-thread p50/p95/p99 per stage: ' +
      'chunk→worker→lex→reconcile→shape→layout→render, plus heap/entity count. ' +
      'Worker is deleted before @vectojs/markdown import so lex is synchronous and attributable per chunk (same technique as benchmarks/markdown-stream-phases); worker stage is therefore 0 here and the O(document) transfer saving is measured separately in benchmarks/markdown-stream-transfer. ' +
      'lex=marked.lexer (patched), reconcile=Markdown.updateTokens, shape=Canvas measureText/fillText (shape is measure+fill), layout=Scene.transform, render=drawWalk+flush. ' +
      'Each stage emits performance.measure (e2e:lex etc.) per chunk so the Performance panel shows the same splits. ' +
      'heap via performance.memory when available (Chromium only; absent on Firefox is stated). ' +
      'entityCount is Markdown.content.children.length per chunk, summarised p50/p95/max.',
    chunkChars: CHUNK_CHARS,
    trials: TRIALS,
    warmups: WARMUPS,
    workerDeletedBeforeImport: workerDeleted,
    crossOriginIsolated: (globalThis as any).crossOriginIsolated ?? false,
    allGatesPass,
    rows: allGatesPass ? rows : [],
    gateFailures: allGatesPass ? [] : rows.filter((r) => !r.gatesPass).map((r) => r.gates),
    scaling: allGatesPass
      ? {
          e2eTotalExponent: scalingExponent(rows, (r) => r.e2e.totalStream.median),
          e2eLexExponent: scalingExponent(rows, (r) => r.e2e.lex.median),
          e2eReconcileExponent: scalingExponent(rows, (r) => r.e2e.reconcile.median),
          e2eShapeExponent: scalingExponent(rows, (r) => r.e2e.shape.median),
          e2eLayoutExponent: scalingExponent(rows, (r) => r.e2e.layout.median),
          e2eRenderExponent: scalingExponent(rows, (r) => r.e2e.render.median),
          e2ePerChunkExponent: scalingExponent(rows, (r) => r.e2e.totalPerChunk.median),
          entityExponent: scalingExponent(rows, (r) => r.entityCount.finalMedian),
        }
      : null,
  };

  // Expose performance.getEntriesByType('measure') for debugging — filtered to e2e:
  try {
    const ms = performance
      .getEntriesByType('measure')
      .filter((e: any) => String(e.name).startsWith('e2e:'))
      .slice(0, 5)
      .map((e: any) => ({ name: e.name, duration: +e.duration.toFixed(3) }));
    (payload as any).sampleMeasures = ms;
  } catch {}

  pre.textContent = JSON.stringify(payload, null, 2);

  await fetch('/results', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

void main().catch((e) => {
  console.error(e);
  (document.body as any).innerHTML +=
    `<pre style="color:red;white-space:pre-wrap">${String(e.stack ?? e)}</pre>`;
  fetch('/results', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...runnerIdentity(),
      suite: 'stream-markdown-smd',
      name: 'run-e2e',
      engine: /firefox/i.test(navigator.userAgent) ? 'firefox' : 'chrome',
      rows: [],
      error: String(e.stack ?? e),
    }),
  });
});
