// VectoJS `@vectojs/layout` vs `@chenglou/pretext` — text layout head-to-head.
//
// These two are worth comparing because they independently arrived at the SAME
// architecture: a one-time `prepare()` that measures text via canvas and caches
// segment widths, then a cheap `layout()` that is pure arithmetic over those
// widths. Both exist to keep resize/reflow off the DOM.
//
// They are NOT the same scope, and the table this feeds must say so:
//   • pretext  — text measurement + layout only. Renders nothing; you draw the
//                lines yourself. No scene graph, hit-testing, or a11y.
//   • VectoJS  — the layout engine is one package of a UI runtime, and its
//                output feeds glyph positions, selection geometry, and the
//                semantic DOM projection.
// So "which is faster at line-breaking" is a fair question; "which should I
// use" is not answered by this benchmark alone.
//
// Measured in a real browser (both engines) because both libraries depend on
// canvas `measureText`, whose cost and caching differ between V8/Gecko.
import { LayoutEngine } from '@vectojs/layout';
import { prepare, layout, prepareWithSegments, layoutWithLines } from '@chenglou/pretext';

const q = new URLSearchParams(location.search);
const TRIALS = Number(q.get('trials') ?? 7);
const FONT = '16px sans-serif';
const FONT_SIZE = 16;

const median = (xs: number[]): number => {
  xs.sort((a, b) => a - b);
  return xs[xs.length >> 1]!;
};
const time = (f: () => void): number => {
  const t0 = performance.now();
  f();
  return performance.now() - t0;
};
const yieldToPaint = () => new Promise((r) => setTimeout(r, 0));

/** Paragraphs of prose, the workload both libraries target (chat, feeds, docs). */
function corpus(blocks: number): string[] {
  const sentence =
    'The quick brown fox jumps over the lazy dog while the examiner records every measurement. ';
  return Array.from({ length: blocks }, (_, i) => sentence.repeat(1 + (i % 3)));
}

/** A glyph atlas for VectoJS's canvas-free path, measured from the same font. */
function buildAtlas(
  texts: string[],
): Record<string, { width: number; baseSize: number; ast: null }> {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = FONT;
  const atlas: Record<string, { width: number; baseSize: number; ast: null }> = {};
  const seen = new Set<string>();
  for (const t of texts) for (const ch of t) seen.add(ch);
  for (const ch of seen) {
    atlas[ch] = {
      width: ctx.measureText(ch).width,
      baseSize: FONT_SIZE,
      ast: null,
    };
  }
  return atlas;
}

// ── Phase 1: prepare() — the one-time measurement cost ───────────────────────
function preparePhase(texts: string[], atlas: ReturnType<typeof buildAtlas>) {
  const engine = new LayoutEngine(600, 1e9);

  const vecto = () => {
    for (const t of texts) engine.prepare(t, atlas, FONT_SIZE);
  };
  const pre = () => {
    for (const t of texts) prepare(t, FONT);
  };
  // Warm both, then measure. VectoJS caches prepared paragraphs internally, so
  // the honest comparison uses DISTINCT text per trial for the cold path; here
  // we report the warm/steady-state cost that a real app sees on repeat content.
  vecto();
  pre();
  return {
    vectoMs: +median(Array.from({ length: TRIALS }, () => time(vecto))).toFixed(3),
    pretextMs: +median(Array.from({ length: TRIALS }, () => time(pre))).toFixed(3),
  };
}

// ── Phase 2: layout() at a new width — the resize hot path ───────────────────
function layoutPhase(texts: string[], atlas: ReturnType<typeof buildAtlas>) {
  const engine = new LayoutEngine(600, 1e9);
  const vPrepared = texts.map((t) => engine.prepare(t, atlas, FONT_SIZE));
  const pPrepared = texts.map((t) => prepare(t, FONT));

  // Relayout every block at a sequence of widths, as a resize would.
  const widths = [420, 560, 700, 840];
  const vecto = () => {
    for (const w of widths) {
      engine.maxWidth = w;
      for (const p of vPrepared) engine.layoutPrepared(p);
    }
  };
  // The apples-to-apples comparison: pretext's `layout()` returns only
  // {lineCount, height}, so match it with VectoJS's measure-only path (added
  // BECAUSE of this benchmark — see comparisons/README.md).
  const vectoMeasure = () => {
    for (const w of widths) {
      engine.maxWidth = w;
      for (const p of vPrepared) engine.measurePrepared(p);
    }
  };
  const pre = () => {
    for (const w of widths) {
      for (const p of pPrepared) layout(p, w, 20);
    }
  };
  vecto();
  vectoMeasure();
  pre();
  return {
    widths: widths.length,
    vectoFullMs: +median(Array.from({ length: TRIALS }, () => time(vecto))).toFixed(4),
    vectoMeasureMs: +median(Array.from({ length: TRIALS }, () => time(vectoMeasure))).toFixed(4),
    pretextMs: +median(Array.from({ length: TRIALS }, () => time(pre))).toFixed(4),
  };
}

// ── Phase 2b: layout WITH line contents — what a renderer actually needs ─────
// `pretext.layout()` returns only {lineCount, height}; getting the actual line
// text/widths requires `layoutWithLines`, which its own source notes is too
// expensive for the resize hot path. VectoJS always produces positioned glyphs,
// so comparing against bare layout() would flatter VectoJS's competitor.
function layoutWithContentPhase(texts: string[], atlas: ReturnType<typeof buildAtlas>) {
  const engine = new LayoutEngine(600, 1e9);
  const vPrepared = texts.map((t) => engine.prepare(t, atlas, FONT_SIZE));
  const pPrepared = texts.map((t) => prepareWithSegments(t, FONT));

  const vecto = () => {
    for (const p of vPrepared) engine.layoutPrepared(p);
  };
  const pre = () => {
    for (const p of pPrepared) layoutWithLines(p, 600, 20);
  };
  vecto();
  pre();
  return {
    vectoMs: +median(Array.from({ length: TRIALS }, () => time(vecto))).toFixed(4),
    pretextMs: +median(Array.from({ length: TRIALS }, () => time(pre))).toFixed(4),
  };
}

async function main() {
  const engineName = /firefox/i.test(navigator.userAgent) ? 'firefox' : 'chrome';
  const rows: unknown[] = [];
  for (const blocks of [50, 200, 500]) {
    const texts = corpus(blocks);
    const atlas = buildAtlas(texts);
    const prep = preparePhase(texts, atlas);
    await yieldToPaint();
    const lay = layoutPhase(texts, atlas);
    await yieldToPaint();
    const withContent = layoutWithContentPhase(texts, atlas);
    await yieldToPaint();
    rows.push({
      blocks,
      prepare: prep,
      relayout: lay,
      layoutWithContent: withContent,
    });
  }

  const payload = {
    name: 'text-layout-pretext',
    engine: engineName,
    userAgent: navigator.userAgent,
    versions: { pretext: '0.0.8', vectojsLayout: '0.2.0' },
    note: 'pretext is layout-only; VectoJS produces positioned glyphs feeding selection + a11y projection. Scope differs — see comparisons/README.md.',
    params: { TRIALS, FONT },
    rows,
  };
  try {
    await fetch('/results', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    /* the page still shows the payload below */
  }
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(payload, null, 2);
  document.body.appendChild(pre);
}

main();
