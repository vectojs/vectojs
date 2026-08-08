// Task 4.4 measurement: where does a RichText drag-resize actually spend time?
//
// TODO.md's entry proposes "a prepared RichText width-only relayout path". CTX-0145
// (PR #293) already delivered most of it: the paragraph memo's key excludes
// `maxWidth`, so a resize is already a memo HIT and re-shapes nothing. The entry
// says only the line-breaking pass remains and demands it be measured before any
// code is written. This benchmark is that measurement.
//
// A resize is `setMaxWidth()` → `layout()`, which is two calls:
//
//   1. prepareRich()   — segment + measure. Should be a pure memo hit on resize.
//   2. layoutPrepared() — wrap decisions + glyph positioning + LayoutNode alloc.
//
// A "width-only relayout path" can only ever remove work from (2), and only the
// part of (2) that is NOT positioning: selection geometry and the a11y projection
// both need positioned glyphs, so the O(glyphs) walk and its nodes are load-bearing
// output, not overhead. `measurePrepared()` already exists as the O(words),
// zero-allocation, break-decisions-only walk, so it is the *floor* — the fastest any
// such path could possibly be while making the same wrap decisions.
//
// So the arms are:
//   prepareMs   — is the memo actually hitting? (verified via cacheStats too)
//   layoutMs    — the full positioning path, what a resize costs today
//   measureMs   — break decisions alone, the floor for a width-only path
//
// `measureMs / layoutMs` is the answer. If breaking is a small share of layout, the
// remaining win is small and the entry is exhausted; the cost is positioning, which
// cannot be skipped without dropping selection and a11y.
import { LayoutEngine } from '@vectojs/layout';
import type { StyledSpan } from '@vectojs/text';
import { RichText } from '@vectojs/ui';
import { awaitStart, reportFailure, reportResult } from '../_shared/client.ts';
import { median } from '../_shared/stats.ts';

const p = new URLSearchParams(location.search);
/** Paragraph counts to sweep. A chat transcript block is 1-3; a document is 40+. */
const PARAGRAPHS = (p.get('paragraphs') ?? '1,8,40').split(',').map(Number);
/** Steps in the simulated drag. 40 matches the CTX-0145 figure this re-scopes. */
const STEPS = Number(p.get('steps') ?? 40);
const TRIALS = Number(p.get('trials') ?? 8);
const FONT = '16px sans-serif';
const BASE_FONT_SIZE = 16;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0x100000000);
}

const WORDS = [
  'layout',
  'engine',
  'wrap',
  'glyph',
  'measure',
  'prepared',
  'paragraph',
  'resize',
  'width',
  'selection',
  'projection',
  'incremental',
  'streaming',
  'canvas',
  'accessible',
];

/**
 * A styled transcript-shaped document: mostly plain runs with bold/link spans
 * sprinkled in, so `prepareRich`'s style-signature keying is exercised rather
 * than the degenerate single-style case.
 */
function makeSpans(paragraphs: number): StyledSpan[] {
  const rand = rng(0x51ce);
  const spans: StyledSpan[] = [];
  for (let i = 0; i < paragraphs; i++) {
    const wordCount = 40 + Math.floor(rand() * 40);
    let buf = '';
    for (let w = 0; w < wordCount; w++) {
      const word = WORDS[Math.floor(rand() * WORDS.length)];
      // Every ~11th word becomes its own styled run, flushing the plain buffer.
      if (w > 0 && w % 11 === 0) {
        spans.push({ text: buf });
        buf = '';
        spans.push({ text: `${word} `, style: rand() < 0.5 ? { bold: true } : { italic: true } });
        continue;
      }
      buf += `${word} `;
    }
    spans.push({ text: `${buf}\n\n` });
  }
  return spans;
}

/** The widths a 40-step drag-resize sweeps through, narrow → wide. */
function widths(steps: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < steps; i++) out.push(320 + Math.round((i / (steps - 1)) * 560));
  return out;
}

/**
 * The real resize path: `setMaxWidth()` per drag step on a live entity.
 *
 * This is what a user actually pays, memo and all, and it is the number the
 * other two arms are shares of.
 */
function benchSetMaxWidth(spans: StyledSpan[], ws: number[]): number {
  const ts: number[] = [];
  for (let t = 0; t < TRIALS; t++) {
    const rt = new RichText(spans, { font: FONT, maxWidth: ws[0], selectable: true });
    const t0 = performance.now();
    for (const w of ws) rt.setMaxWidth(w);
    ts.push(performance.now() - t0);
  }
  return median(ts);
}

/**
 * The same drag decomposed against a bare engine, so prepare and layout are
 * timed apart. `RichText` calls exactly this pair per `setMaxWidth`.
 */
function benchDecomposed(
  spans: StyledSpan[],
  ws: number[],
): { prepareMs: number; layoutMs: number; measureMs: number; prepareHitRate: number } {
  const prepareTs: number[] = [];
  const layoutTs: number[] = [];
  const measureTs: number[] = [];
  let prepareHitRate = 0;

  for (let t = 0; t < TRIALS; t++) {
    const engine = new LayoutEngine(ws[0], 1e9);
    // EMPTY_GLYPH_ATLAS equivalent: one stable object, or the engine drops every
    // memoized paragraph on each call and the memo reads as broken. Same object
    // identity for the whole trial is the whole point.
    const atlas = {};
    // Warm: the first prepare is the miss that populates the memo. A resize is
    // never the first prepare, so timing it here would measure shaping, not
    // resizing.
    engine.prepareRich(spans, atlas, BASE_FONT_SIZE);

    const before = engine.cacheStats().richParagraph;
    let prepareTotal = 0;
    let layoutTotal = 0;
    let measureTotal = 0;

    for (const w of ws) {
      engine.maxWidth = w;

      const p0 = performance.now();
      const prepared = engine.prepareRich(spans, atlas, BASE_FONT_SIZE);
      prepareTotal += performance.now() - p0;

      const l0 = performance.now();
      engine.layoutPrepared(prepared);
      layoutTotal += performance.now() - l0;

      const m0 = performance.now();
      engine.measurePrepared(prepared);
      measureTotal += performance.now() - m0;
    }

    const after = engine.cacheStats().richParagraph;
    const hits = after.hits - before.hits;
    const lookups = hits + (after.misses - before.misses);
    prepareHitRate = lookups > 0 ? hits / lookups : 0;

    prepareTs.push(prepareTotal);
    layoutTs.push(layoutTotal);
    measureTs.push(measureTotal);
  }

  return {
    prepareMs: median(prepareTs),
    layoutMs: median(layoutTs),
    measureMs: median(measureTs),
    prepareHitRate,
  };
}

async function main() {
  await awaitStart();
  const startedAt = performance.now();
  const ws = widths(STEPS);

  const rows = PARAGRAPHS.map((n) => {
    const spans = makeSpans(n);
    const dragMs = benchSetMaxWidth(spans, ws);
    const { prepareMs, layoutMs, measureMs, prepareHitRate } = benchDecomposed(spans, ws);
    // Glyph count: use the engine directly so we don't touch private fields.
    const engineProbe = new LayoutEngine(ws[0], 1e9);
    const probeAtlas = {};
    const probePrepared = engineProbe.prepareRich(spans, probeAtlas, BASE_FONT_SIZE);
    const probeResult = engineProbe.layoutPrepared(probePrepared);
    const glyphs = probeResult.nodes.length;
    return {
      paragraphs: n,
      glyphs,
      // What a drag costs today, end to end.
      dragMs: +dragMs.toFixed(3),
      // Its two halves. prepare should be ~0 and hitRate ~1: that is CTX-0145's
      // win, already banked, and this asserts it is still banked.
      prepareMs: +prepareMs.toFixed(3),
      layoutMs: +layoutMs.toFixed(3),
      prepareHitRate: +prepareHitRate.toFixed(4),
      prepareShare: +(prepareMs / (prepareMs + layoutMs)).toFixed(4),
      // The floor: break decisions with no positioning, no allocation.
      measureMs: +measureMs.toFixed(3),
      // The headroom this TODO entry is asking about. A width-only path that
      // still emits positioned glyphs cannot beat `layoutMs`; one that emits
      // only break decisions costs `measureMs`. The gap is the whole prize.
      breakShareOfLayout: +(measureMs / layoutMs).toFixed(4),
    };
  });

  const result = await reportResult({
    name: 'richtext-width-relayout',
    params: { PARAGRAPHS, STEPS, TRIALS, FONT },
    rows,
    durationMs: +(performance.now() - startedAt).toFixed(1),
  });
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(result, null, 2);
  document.body.appendChild(pre);
}

main().catch((error) => reportFailure('richtext-width-relayout', error));
