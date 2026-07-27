// CTX-0106 — what does viewport culling actually cost, and could WASM help?
//
// Context. The WASM world-AABB kernel is verified 2.7-4.2x faster than JS in
// isolation but is not wired into the render walk. The walk culls in JS instead
// (`Scene.ts:4864`): per entity, per frame, call the virtual `getBounds()`, then
// transform 4 corners and test viewport overlap (~12 flops, in registers,
// interleaved with the transform composition that just produced the matrix).
//
// Before wiring anything, two numbers are needed, and neither exists yet:
//
//   1. COST — how much of a frame does the cull test consume when nothing is
//      culled away? That is the ceiling on what any faster cull could save.
//   2. BENEFIT — how much does culling save when entities are off-viewport?
//      That is what would be lost by getting it wrong.
//
// Method: A/B the same scene. A per-node `performance.now()` probe is useless
// here — it costs far more than the 12 flops it would measure — so instead the
// only difference between arms is whether `getBounds()` returns a box or `null`.
// `null` means "unknown bounds, never cull" (`Entity.getBounds` docstring), so
// the boundless arm skips the entire cull block including the virtual call.
//
//   - onscreen: every entity inside the viewport. Culling can skip nothing, so
//     both arms draw identical work and the delta is PURE cull overhead.
//   - offscreen: every entity outside. The delta is the cull BENEFIT.
//
// The onscreen arm is the honest one for judging a WASM rewrite, and it also
// captures a cost the kernel could never remove: `UIComponent.getBounds()`
// allocates a fresh object literal per call (`UIComponent.ts:122`), and any
// WASM path still has to call it to gather bounds (see `_ensureWasmAabbs`,
// which documents declining to pay exactly this per frame).
import { Entity, Scene } from '@vectojs/core';

interface Row {
  placement: 'onscreen' | 'offscreen';
  bounds: 'bounded' | 'boundless';
  count: number;
  frames: number;
  msPerFrame: number;
  msTotal: number;
  /** (max-min)/median across repeats, so a reader can see if a delta clears the noise. */
  spreadPct: number;
}

const p = new URLSearchParams(location.search);
const COUNTS = (p.get('counts') ?? '5000,20000,50000').split(',').map(Number);
const FRAMES = Number(p.get('frames') ?? 60);
// 9 repeats, not 5: at 20k entities a 5-repeat median still let one arm drift,
// producing an impossible NEGATIVE cull cost (-6.8% Chrome, -33% Firefox) while
// 5k and 50k agreed at +0.4..3.3%. The cull cost sits near the noise floor, so
// separating it needs more samples than the effect it is being compared against.
const REPEATS = Number(p.get('repeats') ?? 9);

const VW = 1200;
const VH = 800;

/**
 * A minimal leaf. `render` draws one small rect so the entity has real paint
 * cost, but deliberately does NOT use `getBatchCircle` — that fast-path has its
 * own cull interaction and would confound the measurement.
 */
class Box extends Entity {
  private readonly reportBounds: boolean;

  constructor(reportBounds: boolean) {
    super();
    this.reportBounds = reportBounds;
  }

  public override getBounds(): {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null {
    // Allocating a fresh object here mirrors UIComponent.getBounds(), which is
    // what production entities actually do.
    return this.reportBounds ? { x: 0, y: 0, width: 8, height: 8 } : null;
  }

  // `Entity.render` is typed `any`, so the renderer it receives is an IRenderer
  // (roundRect/fill), NOT a CanvasRenderingContext2D. Using ctx.fillRect here
  // throws on the first frame with nothing to typecheck it.
  public override render(r: {
    beginPath(): void;
    roundRect(x: number, y: number, w: number, h: number, radii: number | number[]): void;
    fill(color: string): void;
  }): void {
    r.beginPath();
    r.roundRect(0, 0, 8, 8, 0);
    r.fill('#4f8');
  }
}

function build(
  scene: Scene,
  count: number,
  bounded: boolean,
  placement: 'onscreen' | 'offscreen',
): void {
  // A flat sheet of siblings: the walk visits every one, which is the regime
  // where per-node cull cost would matter if it ever does.
  const cols = Math.ceil(Math.sqrt(count));
  for (let i = 0; i < count; i++) {
    const e = new Box(bounded);
    const cx = (i % cols) * 11;
    const cy = Math.floor(i / cols) * 11;
    if (placement === 'onscreen') {
      // Wrap into the viewport so nothing is cullable.
      e.x = cx % (VW - 16);
      e.y = cy % (VH - 16);
    } else {
      // Far off to the right: every entity fails the overlap test.
      e.x = VW + 500 + (cx % 4000);
      e.y = cy % (VH - 16);
    }
    scene.add(e);
  }
}

/**
 * Report failures to the server's /log endpoint.
 *
 * Without this a thrown error just means the page never POSTs, the runner waits
 * out its timeout, and the console output is unreachable — indistinguishable
 * from "the benchmark is slow". Surfacing the message in the server log turns a
 * silent hang into a one-line diagnosis.
 */
function reportFailure(msg: string): void {
  void fetch('/log', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ level: 'error', msg }),
  }).catch(() => {});
}

addEventListener('error', (e) => reportFailure(`uncaught: ${e.message}`));
addEventListener('unhandledrejection', (e) =>
  reportFailure(`unhandled rejection: ${String((e as PromiseRejectionEvent).reason)}`),
);

async function postResults(payload: unknown): Promise<void> {
  try {
    await fetch('/results', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    /* the page also renders the payload as a fallback */
  }
  window.close();
}

async function main(): Promise<void> {
  const canvas = document.createElement('canvas');
  canvas.width = VW;
  canvas.height = VH;
  document.body.appendChild(canvas);
  const pre = document.createElement('pre');
  pre.style.cssText = 'font:12px monospace;white-space:pre-wrap';
  document.body.appendChild(pre);

  const rows: Row[] = [];

  // Interleave the two arms within each (placement, count) cell instead of
  // running all repeats of one arm and then all of the other. Whatever drifts
  // over a run — GC scheduling, thermal/clock state, allocator fragmentation —
  // then hits both arms alike rather than landing entirely on whichever went
  // second. The un-interleaved version produced an impossible negative cull cost
  // at 20k on both engines, which is what prompted this.
  const samplesFor = new Map<string, number[]>();
  const key = (pl: string, b: string, c: number) => `${pl}|${b}|${c}`;

  for (const placement of ['onscreen', 'offscreen'] as const) {
    for (const count of COUNTS) {
      for (let rep = 0; rep < REPEATS; rep++) {
        for (const bounds of ['bounded', 'boundless'] as const) {
          const k = key(placement, bounds, count);
          let samples = samplesFor.get(k);
          if (!samples) {
            samples = [];
            samplesFor.set(k, samples);
          }

          const scene = new Scene(canvas, { disableWindowResize: true });
          scene.resize(VW, VH);
          build(scene, count, bounds === 'bounded', placement);

          // Warm the JIT and let the first-frame allocations settle before timing.
          for (let i = 0; i < 10; i++) scene.step(1 / 60);

          // step() is the right driver here: this measures paint cost, not
          // scheduling, and step() renders unconditionally so every frame counts.
          const t0 = performance.now();
          for (let i = 0; i < FRAMES; i++) scene.step(1 / 60);
          samples.push(performance.now() - t0);

          scene.destroy();
          await new Promise((r) => setTimeout(r, 0));
        }
      }

      for (const bounds of ['bounded', 'boundless'] as const) {
        const samples = samplesFor.get(key(placement, bounds, count))!;
        // Median over repeats: one GC pause in a single run should not decide the
        // comparison this whole benchmark exists to make.
        const sorted = [...samples].sort((a, b) => a - b);
        const msTotal = sorted[Math.floor(sorted.length / 2)]!;
        // Spread is reported so a reader can see whether a delta clears the
        // noise. The 20k cull-cost figure did not, and looked negative.
        const spreadPct = +((100 * (sorted.at(-1)! - sorted[0]!)) / msTotal).toFixed(1);
        rows.push({
          placement,
          bounds,
          count,
          frames: FRAMES,
          msTotal: +msTotal.toFixed(1),
          msPerFrame: +(msTotal / FRAMES).toFixed(3),
          spreadPct,
        });
      }
      pre.textContent = JSON.stringify(rows, null, 1);
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  // Pair the arms into the two numbers the decision needs.
  const find = (pl: string, b: string, c: number) =>
    rows.find((r) => r.placement === pl && r.bounds === b && r.count === c)!;
  const summary = COUNTS.map((count) => {
    const onB = find('onscreen', 'bounded', count).msPerFrame;
    const onN = find('onscreen', 'boundless', count).msPerFrame;
    const offB = find('offscreen', 'bounded', count).msPerFrame;
    const offN = find('offscreen', 'boundless', count).msPerFrame;
    return {
      count,
      // Cost of getBounds() + cull test when nothing can be culled.
      cullCostMsPerFrame: +(onB - onN).toFixed(3),
      cullCostPctOfFrame: +((100 * (onB - onN)) / onB).toFixed(1),
      // What culling saves when everything is off-viewport.
      cullBenefitMsPerFrame: +(offN - offB).toFixed(3),
      cullSpeedupWhenOffscreen: +(offN / offB).toFixed(2),
    };
  });

  const engine = /firefox/i.test(navigator.userAgent) ? 'firefox' : 'chrome';
  const payload = {
    name: 'cull-cost',
    engine,
    userAgent: navigator.userAgent,
    params: {
      frames: FRAMES,
      repeats: REPEATS,
      counts: COUNTS,
      viewport: [VW, VH],
      dpr: devicePixelRatio,
      note: 'A/B on getBounds() returning a box vs null. onscreen delta = pure cull overhead (nothing cullable); offscreen delta = cull benefit. Median of repeats.',
    },
    summary,
    rows,
  };
  pre.textContent = JSON.stringify(payload, null, 2);
  await postResults(payload);
}

void main().catch((e) => {
  reportFailure(`main() threw: ${String(e && (e as Error).stack ? (e as Error).stack : e)}`);
});
