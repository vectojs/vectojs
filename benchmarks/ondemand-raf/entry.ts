// CTX-0105 — onDemand skip rate on the REAL rAF loop.
//
// Every render measurement in this repo so far has driven frames through
// `scene.step()`, which calls `render()` unconditionally: it consults neither
// `renderMode` nor `dirty`. So nothing has ever measured the loop that ships, and
// two consequences of that have already bitten:
//
//   - `render` phase timing reported exactly 0 until `step()` was instrumented too
//     (#238), because the probe lived in the rAF path.
//   - An attempt to answer "does onDemand avoid the per-frame repaint?" with a
//     jsdom + `step()` test produced identical numbers for both render modes,
//     which is structurally impossible to be meaningful.
//
// This drives `scene.start()` and lets the browser schedule frames, injecting
// chunks at a fixed wall-clock rate the way a real LLM stream arrives. That rate
// matters: at 20 chunk/s on a 60Hz display a chunk spans 3 frames, and 12 at
// 240Hz, so a benchmark that renders exactly one frame per chunk UNDERSTATES the
// repaint load rather than overstating it.
//
// The question is narrow and falsifiable: of the frames the loop is offered during
// a stream, how many does `onDemand` actually skip? If it skips most of them, the
// "97x redundant repaint" measured via `step()` is a benchmark artifact and there is
// nothing to optimise. If it skips none, the redundancy is real.
type MarkdownCtor = new (
  text: string,
  opts?: Record<string, unknown>,
) => {
  appendMarkdown(chunk: string): unknown;
  destroy(): void;
};

interface FrameStats {
  renderedFrames: number;
  skippedFrames: number;
  fps: number;
  dirty: boolean;
}

const p = new URLSearchParams(location.search);
/** Chunks per second. 20-50 covers observed LLM token streaming. */
const CHUNK_RATES = (p.get('rates') ?? '20,50').split(',').map(Number);
const STREAM_MS = Number(p.get('streamMs') ?? 4000);
const IDLE_MS = Number(p.get('idleMs') ?? 1500);

const SHAPES: Record<string, (i: number) => string> = {
  prose: (i) =>
    i % 12 === 11
      ? '\n\nA new paragraph begins here and continues for a while. '
      : 'The quick brown fox jumps over the lazy dog. ',
  code: (i) => (i === 0 ? '```ts\nconst a0 = 0;' : `\nconst a${i} = ${i};`),
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** POST results and close, so the run ends when the data lands. */
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

  const { Scene } = (await import('@vectojs/core')) as unknown as {
    Scene: new (
      c: HTMLCanvasElement,
      o?: Record<string, unknown>,
    ) => {
      add: (e: unknown) => unknown;
      start: () => void;
      destroy: () => void;
      resize: (w: number, h: number) => void;
      renderMode: 'always' | 'onDemand';
      frameStats: FrameStats;
      setPhaseTiming: (on: boolean) => void;
      clearRenderPhases: () => void;
      renderPhases: Array<{ phase: string; totalMs: number }>;
    };
  };
  const md0 = (await import('@vectojs/markdown')) as unknown as {
    Markdown: MarkdownCtor;
    codeAtlasStats: () => { hits: number; misses: number; size: number; resets: number } | null;
  };
  const { Markdown, codeAtlasStats } = md0;

  const rows: Array<Record<string, unknown>> = [];

  for (const [shape, chunkOf] of Object.entries(SHAPES)) {
    for (const rate of CHUNK_RATES) {
      for (const mode of ['always', 'onDemand'] as const) {
        const scene = new Scene(canvas, { disableWindowResize: true });
        scene.renderMode = mode;
        scene.resize(900, 700);
        const md = new Markdown(chunkOf(0), { maxWidth: 820 });
        scene.add(md);
        scene.setPhaseTiming(true);
        scene.clearRenderPhases();
        scene.start();

        // Let the loop settle so the baseline counters are past startup.
        await sleep(200);
        const base = { ...scene.frameStats };

        // Inject chunks at wall-clock rate, NOT one per frame. setInterval drifts
        // under load, which is realistic — a real stream is not frame-aligned
        // either, and forcing alignment is exactly the artifact being tested for.
        const periodMs = 1000 / rate;
        let injected = 0;
        const timer = setInterval(() => {
          injected++;
          md.appendMarkdown(chunkOf(injected));
        }, periodMs);
        await sleep(STREAM_MS);
        clearInterval(timer);

        const afterStream = { ...scene.frameStats };

        // Then sit completely idle. onDemand must skip essentially everything
        // here; if it does not, the skip logic is broken rather than merely
        // ineffective during streaming.
        await sleep(IDLE_MS);
        const afterIdle = { ...scene.frameStats };

        const streamRendered = afterStream.renderedFrames - base.renderedFrames;
        const streamSkipped = afterStream.skippedFrames - base.skippedFrames;
        const idleRendered = afterIdle.renderedFrames - afterStream.renderedFrames;
        const idleSkipped = afterIdle.skippedFrames - afterStream.skippedFrames;
        const streamOffered = streamRendered + streamSkipped;
        const idleOffered = idleRendered + idleSkipped;

        const phase = (name: string): number =>
          scene.renderPhases.find((x) => x.phase === name)?.totalMs ?? 0;

        rows.push({
          shape,
          chunkRate: rate,
          mode,
          chunksInjected: injected,
          streamOffered,
          streamRendered,
          streamSkipped,
          // The headline: during a stream, what fraction of offered frames does
          // onDemand actually skip?
          streamSkipPct:
            streamOffered > 0 ? +((100 * streamSkipped) / streamOffered).toFixed(1) : 0,
          idleOffered,
          idleSkipped,
          idleSkipPct: idleOffered > 0 ? +((100 * idleSkipped) / idleOffered).toFixed(1) : 0,
          // Frames rendered per chunk. >1 means a chunk is repainted several
          // times, which is the redundancy the step()-driven bench could not see.
          framesPerChunk: injected > 0 ? +(streamRendered / injected).toFixed(2) : 0,
          renderMs: +phase('render').toFixed(1),
          entityPaintMs: +phase('entityPaint').toFixed(1),
          // Every phase, not just paint: on Chrome/always, paint turned out to be
          // only 26% of render, so 3/4 of the cost was somewhere this benchmark
          // was not looking. Reporting two of seven phases invites optimising the
          // wrong one.
          drawWalkMs: +phase('drawWalk').toFixed(1),
          transformMs: +phase('transform').toFixed(1),
          flushMs: +phase('flush').toFixed(1),
          a11ySyncMs: +phase('a11ySync').toFixed(1),
          a11yOrderMs: +phase('a11yOrder').toFixed(1),
          // Atlas instrumentation: confirms the blit path is actually active and
          // reusing slots. A climbing 'resets' means the glyph set overflows the
          // atlas, so every reset re-rasterizes and the atlas is net harmful.
          atlas: codeAtlasStats(),
        });

        scene.setPhaseTiming(false);
        md.destroy();
        scene.destroy();
        pre.textContent = JSON.stringify(rows, null, 1);
        await sleep(100);
      }
    }
  }

  const engine = /firefox/i.test(navigator.userAgent) ? 'firefox' : 'chrome';
  const payload = {
    name: 'ondemand-raf',
    engine,
    userAgent: navigator.userAgent,
    params: {
      streamMs: STREAM_MS,
      idleMs: IDLE_MS,
      rates: CHUNK_RATES,
      dpr: devicePixelRatio,
      note: 'Drives the REAL rAF loop via scene.start(); chunks injected on wall-clock timers rather than one per frame. step()-driven benchmarks cannot measure onDemand at all, since step() renders unconditionally.',
    },
    rows,
  };
  pre.textContent = JSON.stringify(payload, null, 2);
  await postResults(payload);
}

void main();
