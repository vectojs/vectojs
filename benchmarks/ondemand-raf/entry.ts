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
import {
  awaitStart,
  calibrateRefreshRate,
  reportFailure,
  reportResult,
  type BenchmarkResult,
} from '../_shared/client.ts';
import {
  beginPhaseCapture,
  endPhaseCapture,
  type PhaseCapture,
  type PhaseEntry,
} from '../_shared/phases.ts';

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

/**
 * POST results and close, so the run ends when the data lands.
 *
 * The POST itself now goes through the shared client, which builds the full
 * envelope (and measures the refresh rate for it). Closing the window afterwards
 * is preserved: the runner relies on the page closing itself to end the run.
 *
 * The local `calibrateRefreshRate` this file used to carry is gone — the shared
 * client exports the same function (same median-of-intervals definition, for the
 * same reason: one long frame from a GC pause would drag a mean down, understate
 * the display rate, understate the expected frame count, and so hide the
 * starvation it feeds), and `buildResult` now calibrates for every benchmark.
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
  // Measure the real rAF cadence before any work, so starvation is judged against
  // this display rather than an assumed 60Hz.
  const refreshHz = await calibrateRefreshRate(1000);
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
      // The full entry shape, not just `{ phase, totalMs }`: the generic capture
      // records calls/avg/max too, and narrowing it here would silently drop
      // them back out of the result.
      renderPhases: PhaseEntry[];
    };
  };
  const md0 = (await import('@vectojs/markdown')) as unknown as {
    Markdown: MarkdownCtor;
    codeAtlasStats: () => {
      hits: number;
      misses: number;
      size: number;
      resets: number;
    } | null;
  };
  const { Markdown, codeAtlasStats } = md0;

  const rows: Array<Record<string, unknown>> = [];
  /**
   * The generic per-arm phase breakdown, carried on the envelope rather than in
   * the rows.
   *
   * The named `<phase>Ms` row fields below are kept as they are — committed result
   * files and downstream comparisons reference them — but they are a hand-written
   * list, and that list has already drifted from the engine once: it named 13
   * phases and missed `a11yNodes`. This capture reports whatever
   * `scene.renderPhases` contains, so a 15th engine phase lands in the results
   * without anyone editing this file, and it carries the nesting-aware `selfMs`
   * the flat totals cannot express.
   */
  const phases: Array<{
    shape: string;
    chunkRate: number;
    mode: 'always' | 'onDemand';
    capture: PhaseCapture;
  }> = [];

  for (const [shape, chunkOf] of Object.entries(SHAPES)) {
    for (const rate of CHUNK_RATES) {
      for (const mode of ['always', 'onDemand'] as const) {
        const scene = new Scene(canvas, { disableWindowResize: true });
        scene.renderMode = mode;
        scene.resize(900, 700);
        const md = new Markdown(chunkOf(0), { maxWidth: 820 });
        scene.add(md);
        // Enables timing and clears anything already recorded, exactly as the
        // open-coded setPhaseTiming(true)/clearRenderPhases() pair did. The clear
        // is what keeps each arm's totals its own; phase totals accumulate.
        beginPhaseCapture(scene);
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
        // Detect a starved rAF loop.
        //
        // Browsers throttle or suspend `requestAnimationFrame` for a window that is
        // not visible, so anything that takes focus mid-run — switching workspace,
        // another window raising itself — leaves this arm with a handful of frames
        // or none at all. The per-frame figures then divide by a tiny denominator
        // and read as a spectacular improvement. That has already misled this
        // investigation twice, so the arm now records whether it was starved
        // instead of leaving it to a reader to notice `rendered=0`.
        //
        // The expected count comes from the MEASURED refresh rate, not a hardcoded
        // 60. This display runs at 240Hz, where a 4 s stream offers ~960 frames, so
        // the old 60Hz assumption put the 25% floor at 60 frames — a run starved
        // down to 100 frames passed the check, and its per-frame figures, divided
        // by that collapsed denominator, read as a large win. The hardcode made the
        // guard blind to exactly the severe cases it exists to catch.
        //
        // The threshold stays loose so a merely busy machine does not fail.
        const expectedFrames = (STREAM_MS / 1000) * refreshHz;
        const starved = refreshHz > 0 && streamOffered < expectedFrames * 0.25;
        const idleOffered = idleRendered + idleSkipped;

        // Read the breakdown and turn timing back off. This replaces the
        // `scene.setPhaseTiming(false)` that used to sit after the rows.push, and
        // it must happen before the named fields below are read from it.
        const capture = endPhaseCapture(scene);
        phases.push({ shape, chunkRate: rate, mode, capture });

        // The named row fields are read out of the same capture rather than
        // re-querying the scene, so the flat `<phase>Ms` values and the generic
        // breakdown can never disagree about the run they describe.
        const phase = (name: string): number =>
          capture.entries.find((x) => x.phase === name)?.totalMs ?? 0;

        rows.push({
          shape,
          chunkRate: rate,
          mode,
          chunksInjected: injected,
          streamOffered,
          // When true, every per-frame number in this row is unusable: the rAF loop
          // was throttled, almost always because the window lost focus.
          starved,
          expectedFrames,
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
          //
          // This list is retained for continuity, not for coverage — it names 13
          // phases and still misses `a11yNodes`, which is the drift a hand-written
          // list always accumulates. The exhaustive breakdown is the envelope's
          // `phases`; read that one to answer "where did the frame go".
          drawWalkMs: +phase('drawWalk').toFixed(1),
          transformMs: +phase('transform').toFixed(1),
          flushMs: +phase('flush').toFixed(1),
          a11ySyncMs: +phase('a11ySync').toFixed(1),
          gridMaterializeMs: +phase('gridMaterialize').toFixed(1),
          contentProjectionMs: +phase('contentProjection').toFixed(1),
          gridSyncMs: +phase('gridSync').toFixed(1),
          calibrateScheduleMs: +phase('gridCalibrateSchedule').toFixed(1),
          calibScanMs: +phase('calibScan').toFixed(1),
          calibProbeBuildMs: +phase('calibProbeBuild').toFixed(1),
          a11yOrderMs: +phase('a11yOrder').toFixed(1),
          // Atlas instrumentation: confirms the blit path is actually active and
          // reusing slots. A climbing 'resets' means the glyph set overflows the
          // atlas, so every reset re-rasterizes and the atlas is net harmful.
          atlas: codeAtlasStats(),
        });

        md.destroy();
        scene.destroy();
        pre.textContent = JSON.stringify(rows, null, 1);
        await sleep(100);
      }
    }
  }

  // `runId`, `engine`, `userAgent`, `refreshHz` and `viewport` are gone from here:
  // the shared envelope supplies all five. This benchmark was the one that already
  // carried `runId` and `refreshHz` — the runner still waits for THIS run's result,
  // and the envelope's `refreshHz` is still measured rather than assumed, now for
  // every benchmark instead of only this one.
  //
  // The envelope reuses this page's cached calibration rather than re-measuring, so
  // its `refreshHz` is exactly the value every `expectedFrames` above was derived
  // from. When these were two independent samples they disagreed by 4x on Firefox
  // (58.75 Hz in the rows, 250 Hz in the envelope), which advertised a cadence no
  // arm here was measured against.
  await postResults(
    {
      name: 'ondemand-raf',
      params: {
        streamMs: STREAM_MS,
        idleMs: IDLE_MS,
        rates: CHUNK_RATES,
        dpr: devicePixelRatio,
        note: 'Drives the REAL rAF loop via scene.start(); chunks injected on wall-clock timers rather than one per frame. step()-driven benchmarks cannot measure onDemand at all, since step() renders unconditionally.',
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
  void reportFailure('ondemand-raf', e);
});
