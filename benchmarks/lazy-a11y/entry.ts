// CTX-0067 — what does eager a11y projection cost for high-cardinality ephemeral
// entities (particles, danmaku, game sprites), and what would a lazy mode save?
//
// Motivation: a particle field or danmaku layer has thousands of entities that
// move every frame, carry no useful semantics individually, and will never be
// inspected with F12 or selected as text. Today the only way to make one
// clickable is `interactive = true`, which projects a PERMANENT DOM element per
// entity — and then every synced frame pays:
//
//   1. syncA11y walks the whole tree, writing left/top/width/height inline
//      styles per projected node (a layout-invalidating DOM write per entity).
//   2. enforceA11yDomOrder walks the whole tree AGAIN (the fusion prototyped in
//      #179 was measured, found not to be a hotspot at ~10k, and reverted), then
//      sorts every element by visual position and splices a11yRoot to match.
//
// This bench quantifies that per-frame cost as a function of entity count, in
// four configurations, so the design decision rests on numbers:
//
//   eager-interactive  N entities, interactive = true      (today's only option)
//   lazy-simulated     N entities, interactive = false, +1 projected
//                      (models a lazy mode where only the hovered entity has DOM)
//   non-interactive    N entities, interactive = false     (floor: no projection)
//
// `a11ySyncInterval` throttling is deliberately NOT a row here: it only takes
// effect inside `loop()`, which this bench bypasses, so measuring it would
// report the unthrottled cost under a throttled label. It is a real mitigation,
// just not one this harness can honestly quantify — it trades staleness for cost
// and does nothing about the per-sync O(N) walks themselves.
//
// `lazy-simulated` is the key row: it is NOT an implementation, it measures the
// steady state a lazy mode would reach (one materialized element, everything else
// canvas-only) using existing primitives. If it does not beat eager decisively,
// the design is not worth building.
//
// Posts JSON to /results (hyprland-browser-bench contract).
import { Scene, Entity } from '@vectojs/core';
import {
  awaitStart,
  reportFailure,
  reportResult,
  type BenchmarkResult,
} from '../_shared/client.ts';
import { median } from '../_shared/stats.ts';

const p = new URLSearchParams(location.search);
const COUNTS = (p.get('counts') ?? '1000,5000,20000').split(',').map(Number);
const FRAMES = Number(p.get('frames') ?? 40);
const TRIALS = Number(p.get('trials') ?? 5);

/**
 * A particle: moves every frame, no meaningful individual semantics. `interactive`
 * is set by the config under test.
 */
class Particle extends Entity {
  vx: number;
  vy: number;
  constructor(id: string, interactive: boolean, vx: number, vy: number) {
    super(id);
    this.interactive = interactive;
    this.width = 6;
    this.height = 6;
    this.vx = vx;
    this.vy = vy;
  }
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

interface Config {
  key: string;
  label: string;
  interactive: boolean;
  /** How many entities additionally get a projected element (the "hovered" one). */
  projected: number;
}

const CONFIGS: Config[] = [
  {
    key: 'eager-interactive',
    label: 'every entity interactive (today)',
    interactive: true,
    projected: 0,
  },
  {
    key: 'lazy-simulated',
    label: 'none interactive + 1 projected (lazy steady state)',
    interactive: false,
    projected: 1,
  },
  {
    key: 'non-interactive',
    label: 'none interactive (floor, no a11y DOM)',
    interactive: false,
    projected: 0,
  },
];

function makeScene(count: number, cfg: Config): { scene: Scene; canvas: HTMLCanvasElement } {
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 800;
  document.body.appendChild(canvas);
  const scene = new Scene(canvas);
  // Drive render()/syncA11y manually rather than via rAF so each frame is timed.
  (scene as unknown as { isRunning: boolean }).isRunning = true;

  let seed = 0x9e3779b9;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  for (let i = 0; i < count; i++) {
    const pt = new Particle(
      `p${i}`,
      cfg.interactive || i < cfg.projected,
      (rnd() - 0.5) * 4,
      (rnd() - 0.5) * 4,
    );
    pt.x = rnd() * 1200;
    pt.y = rnd() * 800;
    scene.root.add(pt);
  }
  return { scene, canvas };
}

const yieldToBrowser = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * POST the results, then close the window so the run ends the moment the data
 * lands rather than depending on the harness noticing.
 *
 * The POST itself now goes through the shared client, which builds the full
 * envelope; `render` runs before the close because nothing after
 * `window.close()` is guaranteed to run.
 */
async function postResults(
  input: Parameters<typeof reportResult>[0],
  render: (result: BenchmarkResult) => void,
): Promise<void> {
  const result = await reportResult(input);
  render(result);
  window.close();
}

async function main(): Promise<void> {
  await awaitStart();
  const startedAt = performance.now();
  const pre = document.createElement('pre');
  pre.style.cssText = 'font:12px monospace';
  document.body.appendChild(pre);

  const rows: Record<string, unknown>[] = [];

  for (const count of COUNTS) {
    for (const cfg of CONFIGS) {
      const perTrial: number[] = [];
      let domNodes = 0;

      // Eager projection is super-linear (649ms/frame at 20k entities), while the
      // lazy/non-interactive configs are sub-microsecond. A single frame count
      // cannot resolve both: too few and the cheap configs round to 0.000ms, too
      // many and the eager config alone runs for minutes and trips the harness
      // timeout. So scale the frame count to the configuration's cost.
      const frames = cfg.interactive ? Math.max(3, Math.round(FRAMES / 8)) : FRAMES * 20;

      for (let t = 0; t < TRIALS; t++) {
        const { scene, canvas } = makeScene(count, cfg);
        // Drive the two a11y passes directly rather than `loop()`: `loop()`
        // re-arms itself via `scheduleFrame()` (rAF), so calling it in a tight
        // loop both recurses and blocks the frame it is waiting on — the page
        // hangs with nothing rendered. The a11y-order bench established this
        // pattern for the same reason.
        const s = scene as unknown as {
          syncA11y: (n: unknown) => void;
          enforceA11yDomOrder: () => void;
          root: unknown;
          a11yNeedsReorder: boolean;
        };

        // Warm up: build whatever elements this config projects, once.
        s.syncA11y(s.root);
        s.enforceA11yDomOrder();
        await yieldToBrowser();

        const t0 = performance.now();
        for (let f = 1; f <= frames; f++) {
          // Move every particle so no frame can be skipped as unchanged — this
          // is the defining property of the workload.
          for (const child of scene.root.children) {
            const pt = child as Particle;
            pt.x += pt.vx;
            pt.y += pt.vy;
            if (pt.x < 0 || pt.x > 1200) pt.vx = -pt.vx;
            if (pt.y < 0 || pt.y > 800) pt.vy = -pt.vy;
          }
          // Force the reorder body so the measurement includes the sort+splice
          // an actually-moving scene would pay, not just the walk.
          s.a11yNeedsReorder = true;
          s.syncA11y(s.root);
          s.enforceA11yDomOrder();
        }
        const t1 = performance.now();
        perTrial.push((t1 - t0) / frames);

        if (t === 0) {
          domNodes = (scene as unknown as { a11yElements: Map<string, unknown> }).a11yElements.size;
        }

        scene.destroy();
        canvas.remove();
        await yieldToBrowser();
      }

      const msPerFrame = median(perTrial);
      rows.push({
        entities: count,
        config: cfg.key,
        label: cfg.label,
        msPerFrame: +msPerFrame.toFixed(4),
        framesPerTrial: frames,
        a11yDomNodes: domNodes,
        // Does one frame of this configuration fit a 240Hz budget?
        fits240: msPerFrame < 4.17,
        fits60: msPerFrame < 16.67,
      });
      pre.textContent =
        `measured ${count} / ${cfg.key}…\n` + JSON.stringify(rows.slice(-4), null, 1);
      await yieldToBrowser();
    }
  }

  await postResults(
    {
      name: 'lazy-a11y',
      // `dpr` stays in params as deliberate duplication of the envelope's own
      // field, so the params shape stays comparable.
      params: {
        frames: FRAMES,
        trials: TRIALS,
        dpr: devicePixelRatio,
        note: "lazy-simulated models a lazy mode's steady state (1 projected element) using existing primitives; it is not an implementation",
      },
      rows,
      durationMs: +(performance.now() - startedAt).toFixed(1),
    },
    (result) => {
      pre.textContent = JSON.stringify(result, null, 2);
    },
  );
}

main().catch((error) => reportFailure('lazy-a11y', error));
