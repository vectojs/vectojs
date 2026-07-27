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
};

interface PhaseTotals {
  parse: number;
  reconcile: number;
  render: number;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const yieldToBrowser = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * POST results and close, so the run ends when the data lands rather than
 * depending on the harness noticing.
 */
async function postResults(payload: unknown): Promise<void> {
  try {
    await fetch('/results', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    /* payload is rendered into the page as a fallback */
  }
  window.close();
}

async function main(): Promise<void> {
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
      renderPhases: Array<{
        phase: string;
        totalMs: number;
        calls: number;
        avgMs: number;
        maxMs: number;
        share: number | null;
      }>;
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

  for (const [shape, chunkOf] of Object.entries(SHAPES)) {
    const perTrial: PhaseTotals[] = [];
    const renderPhaseSamples: Array<Record<string, number>> = [];

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
      scene.setPhaseTiming(true);
      scene.clearRenderPhases();

      // Attribute by PATCHING the two functions an append actually calls, rather
      // than estimating one term and subtracting it. `appendMarkdown` on the
      // stubbed-worker path does exactly: marked.lexer(source) then
      // updateTokens(tokens). Wrapping both gives real per-phase numbers instead
      // of an average-based guess.
      const mdAny = md as unknown as { updateTokens: (...a: unknown[]) => unknown };
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

      renderPhaseSamples.push(
        Object.fromEntries(scene.renderPhases.map((p) => [p.phase, p.totalMs])) as Record<
          string,
          number
        >,
      );
      scene.setPhaseTiming(false);
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

  const engine = /firefox/i.test(navigator.userAgent) ? 'firefox' : 'chrome';
  if (RealWorker !== undefined) (globalThis as { Worker?: unknown }).Worker = RealWorker;
  const payload = {
    name: 'markdown-stream-phases',
    engine,
    userAgent: navigator.userAgent,
    params: {
      chunks: CHUNKS,
      trials: TRIALS,
      dpr: devicePixelRatio,
      note: 'Worker REMOVED before import so the synchronous path runs and parse is synchronous and attributable to its append; the worker transport cost is measured by markdown-stream-transfer instead. parse = marked.lexer over the accumulated source (the O(N)/chunk floor). reconcile = append minus one internal lex. render = scene.step.',
    },
    rows,
  };
  pre.textContent = JSON.stringify(payload, null, 2);
  await postResults(payload);
}

void main();
