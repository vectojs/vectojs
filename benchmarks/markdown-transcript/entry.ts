// CTX-0148 — the aggregate cost of streaming a whole LLM transcript.
//
// Eight per-type reuse paths shipped between CTX-0135 and CTX-0147 (code,
// paragraph, heading, blockquote, math, list, table, image paragraph), each
// measured on its own shape in `markdown-stream-phases`. That bench answers "is
// this construct's fast path working"; it cannot answer "what does a real
// conversation cost", for two reasons this bench exists to fix:
//
//  1. Every shape there grows ONE construct. Its `mixed` shape emits every
//     non-prose block whole, so no block ever grows across chunks. Interactions
//     between block types are therefore invisible — and one of them was large:
//     CTX-0144 found `mixed` improving 31% because a list arriving whole was the
//     TRAILING token, so every following prose chunk rebuilt it. Nothing in a
//     single-construct shape can surface that.
//  2. Per-shape deltas cannot be summed. Eight numbers between −24% and −73% say
//     nothing about the total, because they weight constructs equally when a real
//     document does not.
//
// So this measures one figure: a full assistant transcript, streamed token by
// token, with every block type present in the proportion real technical Markdown
// actually uses.
//
// The corpus and the chunk splitter live in `corpus.ts`, which documents the
// measured block weighting and why granularity dominates the result.
import { awaitStart, reportFailure, reportResult } from '../_shared/client.ts';
import {
  beginPhaseCapture,
  endPhaseCapture,
  medianPhaseCapture,
  type PhaseCapture,
} from '../_shared/phases.ts';
import { median } from '../_shared/stats.ts';
import { chunkify, transcript } from './corpus.ts';

type MarkdownCtor = new (
  text: string,
  opts?: Record<string, unknown>,
) => {
  appendMarkdown(chunk: string): unknown;
  destroy(): void;
  content: { children: unknown[] };
  height: number;
};

const p = new URLSearchParams(location.search);
const TRIALS = Number(p.get('trials') ?? 7);
/** `token` (~4 chars, real SSE), `sentence`, or a fixed char count. */
const GRANULARITY = p.get('granularity') ?? 'token';
/** Assistant turns in the transcript. Each turn is a multi-block answer. */
const TURNS = Number(p.get('turns') ?? 6);

interface Totals {
  parse: number;
  reconcile: number;
  render: number;
}

const yieldToBrowser = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function main(): Promise<void> {
  await awaitStart();
  const startedAt = performance.now();
  const canvas = document.createElement('canvas');
  canvas.width = 900;
  canvas.height = 700;
  document.body.appendChild(canvas);
  const pre = document.createElement('pre');
  pre.style.cssText = 'font:12px monospace;white-space:pre-wrap';
  document.body.appendChild(pre);

  // Force the synchronous lex path, as `markdown-stream-phases` does: a real
  // worker makes the lex asynchronous and unattributable to the append that
  // caused it, which would make `parse` and `reconcile` meaningless here.
  const RealWorker = (globalThis as { Worker?: unknown }).Worker;
  delete (globalThis as { Worker?: unknown }).Worker;
  const { Markdown } = (await import('@vectojs/markdown')) as unknown as {
    Markdown: MarkdownCtor;
  };
  const { Scene } = (await import('@vectojs/core')) as unknown as {
    Scene: new (
      c: HTMLCanvasElement,
      o?: Record<string, unknown>,
    ) => {
      resize(w: number, h: number): void;
      add(e: unknown): void;
      step(dt: number): void;
      destroy(): void;
    };
  };
  const markedModule = (await import('marked')) as unknown as {
    marked: { lexer: (src: string) => unknown };
  };

  const doc = transcript(TURNS);
  const chunks = chunkify(doc, GRANULARITY);

  // Report the corpus mix so a reader can audit the weighting rather than
  // trusting this file's comment.
  const blockCounts: Record<string, number> = {};
  let blockChars = 0;
  for (const tok of markedModule.marked.lexer(doc) as Array<{
    type: string;
    raw?: string;
  }>) {
    if (tok.type === 'space') continue;
    blockCounts[tok.type] = (blockCounts[tok.type] ?? 0) + 1;
    blockChars += tok.raw?.length ?? 0;
  }

  const perTrial: Totals[] = [];
  const captures: PhaseCapture[] = [];
  const streamStats: Array<Record<string, number>> = [];
  let finalHeight = 0;
  let finalBlocks = 0;

  for (let t = 0; t < TRIALS; t++) {
    const scene = new Scene(canvas, { disableWindowResize: true });
    scene.resize(900, 700);
    const md = new Markdown('', { maxWidth: 820 });
    scene.add(md);
    scene.step(16.67);

    const totals: Totals = { parse: 0, reconcile: 0, render: 0 };
    let parseMs = 0;
    let reconcileMs = 0;

    // Same attribution technique as `markdown-stream-phases`: time one internal
    // lex and the reconcile separately, so `reconcile` is append minus parse.
    const originalLexer = markedModule.marked.lexer.bind(markedModule.marked);
    const mdAny = md as unknown as Record<string, (...a: unknown[]) => unknown>;
    const originalUpdate = mdAny.updateTokens.bind(mdAny);
    markedModule.marked.lexer = (...args: unknown[]) => {
      const t0 = performance.now();
      const out = originalLexer(...args);
      parseMs += performance.now() - t0;
      return out;
    };
    mdAny.updateTokens = (...args: unknown[]) => {
      const t0 = performance.now();
      const out = originalUpdate(...args);
      reconcileMs += performance.now() - t0;
      return out;
    };

    beginPhaseCapture(scene);
    for (const chunk of chunks) {
      md.appendMarkdown(chunk);
      const l0 = performance.now();
      scene.step(16.67);
      totals.render += performance.now() - l0;
    }
    markedModule.marked.lexer = originalLexer;
    mdAny.updateTokens = originalUpdate;
    totals.parse = parseMs;
    totals.reconcile = reconcileMs;

    const stats = (md as unknown as { streamStats?: Record<string, number> }).streamStats;
    if (stats) streamStats.push({ ...stats });
    finalHeight = md.height;
    finalBlocks = md.content.children.length;

    captures.push(endPhaseCapture(scene));
    perTrial.push(totals);
    md.destroy();
    scene.destroy();
    await yieldToBrowser();
  }

  if (RealWorker !== undefined) (globalThis as { Worker?: unknown }).Worker = RealWorker;

  const pick = (k: keyof Totals): number => median(perTrial.map((x) => x[k]));
  const parse = pick('parse');
  const reconcile = pick('reconcile');
  const render = pick('render');
  const total = parse + reconcile + render;
  const share = (v: number): number => (total > 0 ? +((100 * v) / total).toFixed(1) : 0);
  const stat = (k: string): number => median(streamStats.map((s) => s[k] ?? 0));

  const rows = [
    {
      shape: 'transcript',
      granularity: GRANULARITY,
      turns: TURNS,
      chunks: chunks.length,
      docChars: doc.length,
      parseMs: +parse.toFixed(2),
      reconcileMs: +reconcile.toFixed(2),
      renderMs: +render.toFixed(2),
      totalMs: +total.toFixed(2),
      msPerChunk: +(total / chunks.length).toFixed(3),
      parseShare: share(parse),
      reconcileShare: share(reconcile),
      renderShare: share(render),
      // The reuse counters are what make an aggregate figure auditable: a
      // regression that silently stops reusing shows here before it shows in ms.
      inPlaceUpdates: stat('inPlaceUpdates'),
      entitiesRebuilt: stat('entitiesRebuilt'),
      entitiesReused: stat('entitiesReused'),
      finalBlocks,
      finalHeight: +finalHeight.toFixed(1),
    },
  ];
  pre.textContent = JSON.stringify(rows, null, 1);

  const result = await reportResult({
    name: 'markdown-transcript',
    params: {
      trials: TRIALS,
      turns: TURNS,
      granularity: GRANULARITY,
      dpr: devicePixelRatio,
      blockCounts,
      blockChars,
      note: 'One full assistant transcript streamed at the given granularity, block-weighted to the measured mix of 2503 blocks across 75 real technical Markdown files. Worker REMOVED before import so the lex is synchronous and attributable. parse = marked.lexer over the accumulated source (the O(N)/chunk floor); reconcile = append minus that lex; render = scene.step. Granularity dominates reuse work (47x spread token vs sentence on one document), so any figure from here must be quoted with it.',
    },
    rows,
    phases: [{ shape: 'transcript', capture: medianPhaseCapture(captures) }],
    durationMs: +(performance.now() - startedAt).toFixed(1),
  });
  pre.textContent = JSON.stringify(result, null, 2);
}

main().catch((e) => {
  void reportFailure('markdown-transcript', e);
});
