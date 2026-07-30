// CTX-0095 — Markdown streaming cost, split by phase.
//
// This exists because the streaming roadmap's items are all justified by READING
// the code, and one of them was wrong by that method. #232 proposed reusing
// `CodeBlock` in place (via a `setCode()` that existed but was never called) as
// the win for a streaming fenced block. Measured: 34.07ms before, 34.07ms after —
// the reuse fired on every chunk and changed nothing, because the cost was one
// level down, in `buildLines` re-highlighting every line on every call.
//
// A per-append total cannot tell you that. So this bench attributes each append to
// a phase, and reports each phase's share:
//
//   parse      `marked.lexer` over the whole accumulated source. Unavoidably
//              O(N) per chunk today (marked has no incremental lexer), so this is
//              the floor any reconciliation work is measured against.
//   reconcile  token diff -> Entity tree updates: prefix match, in-place updates,
//              destroy/create of the changed tail.
////   render     the retained-mode draw of the resulting tree.
//
// The point is the RATIO. A phase that is 5% of an append cannot be worth
// optimising however inefficient it looks in isolation, and that is precisely the
// mistake this bench is here to prevent on the remaining roadmap items
// (worker-owned source, committed-prefix parser).
//
// Runs in a real browser via hyprland-browser-bench: layout and render depend on
// real text measurement and a real compositor, neither of which Node has.
import {
  awaitStart,
  reportFailure,
  reportResult,
  type BenchmarkResult,
} from '../_shared/client.ts';
import {
  beginPhaseCapture,
  endPhaseCapture,
  medianPhaseCapture,
  type PhaseCapture,
  type PhaseEntry,
} from '../_shared/phases.ts';
import { median } from '../_shared/stats.ts';

type MarkdownCtor = new (
  text: string,
  opts?: Record<string, unknown>,
) => {
  appendMarkdown(chunk: string): unknown;
  setContent(text: string): unknown;
  destroy(): void;
  content: { children: unknown[] };
};

const p = new URLSearchParams(location.search);
const CHUNKS = Number(p.get('chunks') ?? 200);
const TRIALS = Number(p.get('trials') ?? 7);

/**
 * Three stream shapes, because the phase mix differs sharply between them and a
 * single shape would generalise a conclusion that does not hold.
 *
 * `prose` is the common case and the one with an in-place fast path. `code` has no
 * inline-token work but re-highlights lines. `mixed` forces block-structure churn,
 * which is the only shape that regularly destroys and recreates entities.
 */
const SHAPES: Record<string, (i: number) => string> = {
  prose: (i) =>
    i % 12 === 11
      ? '\n\nA new paragraph begins here and continues for a while. '
      : 'The quick brown fox jumps over the lazy dog. ',
  code: (i) => (i === 0 ? '```ts\nconst a0 = 0;' : `\nconst a${i} = ${i};`),
  mixed: (i) => {
    if (i % 10 === 0) return `\n\n## Heading ${i / 10}\n\n`;
    if (i % 10 === 5) return '\n\n- a list item\n- another item\n';
    if (i % 10 === 7) return '\n\n```ts\nconst x = 1;\n```\n\n';
    return 'Some prose that keeps accumulating in the current block. ';
  },
  // A blockquote that GROWS line by line, which `mixed` never produces. A quote
  // owns a subtree (border + one wrapper per inner block), so before tail-child
  // reuse every chunk rebuilt all of it. Mixes the three reusable tail types so
  // the shape covers paragraph, heading, and code descent.
  blockquote: (i) => {
    const step = i % 12;
    if (step === 0) return `\n\n> Quote ${Math.floor(i / 12)} opens here`;
    if (step < 5) return `\n> continued line ${step}`;
    if (step === 5) return '\n>\n> ## nested heading';
    if (step < 8) return ` more${step}`;
    if (step === 8) return '\n>\n> ```ts\n> const a = 1;';
    if (step < 11) return `\n> const b${step} = ${step};`;
    return '\n\nA body paragraph between quotes. ';
  },
  // A heading that GROWS a word at a time, which `mixed` never produces: it emits
  // each heading whole in one chunk, so the heading is complete on its first lex
  // and the reconciler only ever sees it as an unchanged prefix token. This shape
  // is what exercises the in-place heading path — an 8-word heading, then a short
  // body so the next heading starts a new block rather than growing forever.
  headings: (i) => {
    const step = i % 12;
    if (step === 0) return `\n\n## Section ${Math.floor(i / 12)}`;
    if (step < 8) return ` word${step}`;
    if (step === 8) return '\n\nA short body paragraph under the heading. ';
    return 'More body text to close out the section. ';
  },
};

interface PhaseTotals {
  parse: number;
  reconcile: number;
  render: number;
}

const yieldToBrowser = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * POST results and close, so the run ends when the data lands rather than
 * depending on the harness noticing.
 *
 * The POST itself now goes through the shared client, which builds the full
 * envelope. The local `median` this file used to carry is gone in favour of
 * `../_shared/stats.ts`, which is the same definition this file used (the two
 * middle values averaged on an even count).
 */
async function postResults(
  input: Parameters<typeof reportResult>[0],
  render: (result: BenchmarkResult) => void,
): Promise<void> {
  const result = await reportResult(input);
  // Render before closing: the original set the on-page dump first so it stays
  // the visible fallback, and nothing after window.close() is guaranteed to run.
  render(result);
  window.close();
}

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

  // Force the SYNCHRONOUS path by removing `Worker` before the module is
  // imported (it creates its worker at load time). Routing through a real worker
  // makes the lex asynchronous and unattributable to the append that caused it,
  // which defeats the entire purpose here — and an earlier version of this bench
  // claimed to stub the worker while not actually doing so, which is exactly how
  // it reported 0.0ms for both parse and reconcile.
  //
  // The worker transport cost is a separate question, measured by
  // `markdown-stream-transfer`.
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
      add: (e: unknown) => unknown;
      step: (dt: number) => void;
      resize: (w: number, h: number) => void;
      destroy: () => void;
      setPhaseTiming: (on: boolean) => void;
      clearRenderPhases: () => void;
      // Structurally identical to the entry shape spelled out here before; it is
      // now named once in ../_shared/phases.ts instead.
      renderPhases: PhaseEntry[];
    };
  };
  // Import `marked` AFTER @vectojs/markdown so both resolve to the same module
  // instance in the bundle — patching a second copy would time nothing, which is
  // the other half of why the first run of this bench read 0.0ms.
  const markedModule = (await import('marked')) as unknown as {
    marked: { lexer: (src: string) => unknown };
    lexer: (src: string) => unknown;
  };

  const rows: Array<Record<string, unknown>> = [];
  /**
   * The generic per-shape phase breakdown, carried on the envelope.
   *
   * `renderBreakdown` in the rows below is kept as it is, but it is a hardcoded
   * 7-name subset of the 14 phases the engine reports, and it silently dropped the
   * other seven: gridMaterialize, contentProjection, a11yNodes, gridSync,
   * gridCalibrateSchedule, calibScan, calibProbeBuild. This capture keeps whatever
   * `scene.renderPhases` reports, so nothing is dropped and a new engine phase
   * needs no edit here.
   */
  const phases: Array<{ shape: string; capture: PhaseCapture }> = [];

  for (const [shape, chunkOf] of Object.entries(SHAPES)) {
    const perTrial: PhaseTotals[] = [];
    /**
     * Per-trial captures, median-combined per phase at the end of the shape.
     *
     * Per-phase medians rather than the phases of the median trial, so one trial's
     * `flush` spiking does not also distort its `transform`.
     */
    const captures: PhaseCapture[] = [];
    const renderPhaseSamples: Array<Record<string, number>> = [];
    const textSamples: Array<{
      measureMs: number;
      measureCalls: number;
      fillMs: number;
      fillCalls: number;
    }> = [];

    for (let t = 0; t < TRIALS; t++) {
      const scene = new Scene(canvas, { disableWindowResize: true });
      scene.resize(900, 700);
      const md = new Markdown(chunkOf(0), { maxWidth: 820 });
      scene.add(md);
      scene.step(16.67);

      const totals: PhaseTotals = {
        parse: 0,
        reconcile: 0,
        render: 0,
      };
      // Decompose the render term. #234 established render is 85-99% of an append
      // but could not say what is inside it, which is the gap this closes.
      //
      // Enables timing and clears anything already recorded — the same pair of
      // calls as before, named once.
      beginPhaseCapture(scene);

      // Split entityPaint into text SHAPING vs RASTERIZATION by timing the two
      // canvas calls directly. Patching the prototype is the same technique used
      // for the lexer above, and is more precise than reading a DevTools profile:
      // Chrome does not always give Canvas2D calls their own stack frame.
      //
      // Caveat worth stating: `fillText`'s JS-visible time can UNDERSTATE real
      // raster cost, because the browser may defer rasterization (the same reason
      // GPU submit needs gl.finish() to attribute). `measureText` is synchronous
      // and fully attributable, so a large measureText share is trustworthy while
      // a small fillText share is a lower bound.
      const proto = CanvasRenderingContext2D.prototype as unknown as {
        measureText: (t: string) => TextMetrics;
        fillText: (t: string, x: number, y: number, mw?: number) => void;
      };
      const originalMeasure = proto.measureText;
      const originalFill = proto.fillText;
      let measureMs = 0;
      let measureCalls = 0;
      let fillMs = 0;
      let fillCalls = 0;
      proto.measureText = function (this: CanvasRenderingContext2D, text: string) {
        const t0 = performance.now();
        const out = originalMeasure.call(this, text);
        measureMs += performance.now() - t0;
        measureCalls++;
        return out;
      };
      proto.fillText = function (
        this: CanvasRenderingContext2D,
        text: string,
        x: number,
        y: number,
        mw?: number,
      ) {
        const t0 = performance.now();
        originalFill.call(this, text, x, y, mw);
        fillMs += performance.now() - t0;
        fillCalls++;
      };

      // Attribute by PATCHING the two functions an append actually calls, rather
      // than estimating one term and subtracting it. `appendMarkdown` on the
      // stubbed-worker path does exactly: marked.lexer(source) then
      // updateTokens(tokens). Wrapping both gives real per-phase numbers instead
      // of an average-based guess.
      const mdAny = md as unknown as {
        updateTokens: (...a: unknown[]) => unknown;
      };
      const originalLexer = markedModule.marked.lexer.bind(markedModule.marked);
      const originalUpdate = mdAny.updateTokens.bind(mdAny);
      let parseMs = 0;
      let reconcileMs = 0;
      markedModule.marked.lexer = (src: string) => {
        const t0 = performance.now();
        const out = originalLexer(src);
        parseMs += performance.now() - t0;
        return out;
      };
      mdAny.updateTokens = (...args: unknown[]) => {
        const t0 = performance.now();
        const out = originalUpdate(...args);
        reconcileMs += performance.now() - t0;
        return out;
      };

      for (let i = 1; i < CHUNKS; i++) {
        md.appendMarkdown(chunkOf(i));
        const l0 = performance.now();
        scene.step(16.67);
        totals.render += performance.now() - l0;
      }

      markedModule.marked.lexer = originalLexer;
      mdAny.updateTokens = originalUpdate;
      totals.parse = parseMs;
      totals.reconcile = reconcileMs;

      proto.measureText = originalMeasure;
      proto.fillText = originalFill;
      textSamples.push({ measureMs, measureCalls, fillMs, fillCalls });
      // One read of the scene per trial, kept whole. `renderPhaseSamples` — which
      // the named `renderBreakdown` fields below are computed from — is derived
      // from that same capture rather than reading `scene.renderPhases` a second
      // time, so the named subset and the full breakdown cannot describe different
      // states. `endPhaseCapture` also turns timing back off, replacing the
      // `scene.setPhaseTiming(false)` that used to sit here.
      const capture = endPhaseCapture(scene);
      captures.push(capture);
      renderPhaseSamples.push(
        Object.fromEntries(capture.entries.map((e) => [e.phase, e.totalMs])) as Record<
          string,
          number
        >,
      );
      perTrial.push(totals);
      md.destroy();
      scene.destroy();
      await yieldToBrowser();
    }

    const pick = (k: keyof PhaseTotals): number => median(perTrial.map((x) => x[k]));
    const parse = pick('parse');
    const reconcile = pick('reconcile');
    const render = pick('render');
    const total = parse + reconcile + render;
    const share = (v: number): number => +((100 * v) / total).toFixed(1);

    // Median each render sub-phase across trials, and express as a share of the
    // render total — the share is what decides whether a phase is worth attacking.
    const subPhase = (name: string): number => median(renderPhaseSamples.map((x) => x[name] ?? 0));
    const renderTotal = subPhase('render');
    const subShare = (name: string): number =>
      renderTotal > 0 ? +((100 * subPhase(name)) / renderTotal).toFixed(1) : 0;

    // Per-phase medians across trials of this shape. Kept whole and put on the
    // envelope; `renderBreakdown` below names only 7 of the 14 phases in it.
    phases.push({ shape, capture: medianPhaseCapture(captures) });

    rows.push({
      shape,
      renderBreakdown: {
        renderMs: +renderTotal.toFixed(2),
        transformMs: +subPhase('transform').toFixed(2),
        drawWalkMs: +subPhase('drawWalk').toFixed(2),
        flushMs: +subPhase('flush').toFixed(2),
        a11ySyncMs: +subPhase('a11ySync').toFixed(2),
        a11yOrderMs: +subPhase('a11yOrder').toFixed(2),
        entityPaintMs: +subPhase('entityPaint').toFixed(2),
        // entityPaint is nested INSIDE drawWalk, so its share is of drawWalk —
        // that ratio says whether the cost is painting or the traversal.
        measureTextMs: +median(textSamples.map((x) => x.measureMs)).toFixed(2),
        measureTextCalls: Math.round(median(textSamples.map((x) => x.measureCalls))),
        fillTextMs: +median(textSamples.map((x) => x.fillMs)).toFixed(2),
        fillTextCalls: Math.round(median(textSamples.map((x) => x.fillCalls))),
        entityPaintOfDrawWalk:
          subPhase('drawWalk') > 0
            ? +((100 * subPhase('entityPaint')) / subPhase('drawWalk')).toFixed(1)
            : 0,
        transformShare: subShare('transform'),
        drawWalkShare: subShare('drawWalk'),
        flushShare: subShare('flush'),
      },
      chunks: CHUNKS,
      parseMs: +parse.toFixed(2),
      reconcileMs: +reconcile.toFixed(2),
      renderMs: +render.toFixed(2),
      totalMs: +total.toFixed(2),
      parseShare: share(parse),
      reconcileShare: share(reconcile),
      renderShare: share(render),
      msPerChunk: +(total / CHUNKS).toFixed(3),
    });
    pre.textContent = JSON.stringify(rows, null, 1);
    await yieldToBrowser();
  }

  if (RealWorker !== undefined) (globalThis as { Worker?: unknown }).Worker = RealWorker;
  // `engine` and `userAgent` are gone from here: the shared envelope supplies both.
  await postResults(
    {
      name: 'markdown-stream-phases',
      params: {
        chunks: CHUNKS,
        trials: TRIALS,
        dpr: devicePixelRatio,
        note: 'Worker REMOVED before import so the synchronous path runs and parse is synchronous and attributable to its append; the worker transport cost is measured by markdown-stream-transfer instead. parse = marked.lexer over the accumulated source (the O(N)/chunk floor). reconcile = append minus one internal lex. render = scene.step.',
      },
      rows,
      phases,
      durationMs: +(performance.now() - startedAt).toFixed(1),
    },
    (result) => {
      pre.textContent = JSON.stringify(result, null, 2);
    },
  );
}

void main().catch((e) => {
  void reportFailure('markdown-stream-phases', e);
});
