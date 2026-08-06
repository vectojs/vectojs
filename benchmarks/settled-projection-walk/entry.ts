// CTX-0222 / vectojs#350 — cost of a SETTLED content-projection walk.
//
// `syncContentProjection` already early-returns for an unchanged block, but only
// after paying `getWorldTransform()` plus up to three `projectionBoxVisible()`
// calls, each an O(ancestor-depth) ancestor walk. On a document that has stopped
// changing, that is the entire remaining per-frame cost — measured 3.0-3.2 ms at
// 10 000 blocks, 72% of a 4.16 ms frame at 240 Hz, paid forever (CTX-0203,
// PX-0401).
//
// This measures one settled `syncA11y` pass with the settled-walk fast path
// enabled vs disabled, so the run carries its own control arm rather than
// depending on a comparison against a different commit. `disableSettledFastPath`
// is a test-only escape hatch on Scene for exactly this purpose.
//
// The config is the one `vectojs-gallery` ships (`shell-config.ts`): a resident
// semantic tier (`contentSemanticMargin: Infinity`) with a finite carrier margin.
// That pairing is what makes the walk cost 2 box tests per block rather than 1.
import { Entity, Scene } from '@vectojs/core';
import type { ContentProjection, ContentProjectionHint } from '@vectojs/core';
import {
  awaitStart,
  calibrateRefreshRate,
  reportFailure,
  reportResult,
} from '../_shared/client.ts';
import { median } from '../_shared/stats.ts';

const p = new URLSearchParams(location.search);
const BLOCK_COUNTS = (p.get('blocks') ?? '1000,2500,5000,10000').split(',').map(Number);
const TRIALS = Number(p.get('trials') ?? 30);
const VIEW_W = 900;
const VIEW_H = 700;
const LINE_H = 20;
const LINES = 4;
const PITCH = LINES * LINE_H + 14;
/** The gallery's carrier margin. */
const CARRIER_MARGIN = 1200;

/** A multi-line text block, honouring the band hint the way real entities do. */
class Block extends Entity {
  public epoch = 1;

  constructor(id: string) {
    super(id);
    this.width = 600;
    this.height = LINES * LINE_H;
  }

  public override isPointInside(): boolean {
    return false;
  }

  public override render(): void {}

  public override getContentEpoch(): number {
    return this.epoch;
  }

  public override getContentProjection(hint?: ContentProjectionHint): ContentProjection {
    const lines: NonNullable<ContentProjection['lines']> = [];
    for (let i = 0; i < LINES; i++) {
      const y = i * LINE_H;
      if (hint?.minY !== undefined && hint.maxY !== undefined) {
        if (!(y + LINE_H >= hint.minY && y <= hint.maxY)) continue;
      }
      lines.push({
        text: `${this.id} line ${i} with enough text to be a realistic block`,
        x: 0,
        y,
        width: 600,
        height: LINE_H,
      });
    }
    return {
      text: `${this.id} full text`,
      lineHeight: LINE_H,
      selectable: true,
      lines,
    };
  }
}

interface Built {
  scene: Scene;
  canvas: HTMLCanvasElement;
  sync: () => void;
  destroy: () => void;
}

function build(count: number): Built {
  const canvas = document.createElement('canvas');
  canvas.width = VIEW_W;
  canvas.height = VIEW_H;
  canvas.style.cssText = `display:block;width:${VIEW_W}px;height:${VIEW_H}px`;
  document.body.appendChild(canvas);
  const scene = new Scene(canvas, {
    contentProjectionMargin: CARRIER_MARGIN,
    contentSemanticMargin: Number.POSITIVE_INFINITY,
    // Unbudgeted: this measures the SETTLED walk, so the document must be allowed
    // to fully materialize before the timed passes start.
    contentSemanticBudget: Number.POSITIVE_INFINITY,
    disableWindowResize: true,
  });
  (scene as unknown as { isRunning: boolean }).isRunning = true;
  scene.maxFPS = 0;
  // Scroll to the middle so blocks sit off-viewport in both directions, which is
  // the shape a long document actually has.
  const scrollY = Math.max(0, (count * PITCH) / 2 - VIEW_H / 2);
  for (let i = 0; i < count; i++) {
    const b = new Block(`b${i}`);
    b.setPosition(20, i * PITCH - scrollY);
    scene.add(b);
  }
  const s = scene as unknown as { syncA11y: (n: Entity) => void; root: Entity };
  const sync = () => s.syncA11y(s.root);
  return {
    scene,
    canvas,
    sync,
    destroy() {
      scene.destroy();
      canvas.remove();
      (scene as unknown as { a11yRoot: HTMLElement | null }).a11yRoot?.remove();
    },
  };
}

/**
 * Median cost of one settled sync, with the fast path either on or off.
 *
 * Drains to a settled state FIRST in both arms, so neither pays materialization
 * inside the timed window. The forced layout read per pass keeps the browser from
 * batching style work outside the measurement.
 */
function settledSyncMs(count: number, fastPath: boolean): { ms: number; carriers: number } {
  const b = build(count);
  const s = b.scene as unknown as { disableSettledFastPath: boolean };
  // Always drain with the fast path OFF, so both arms start from an identical,
  // fully-materialized DOM regardless of which arm is being timed.
  s.disableSettledFastPath = true;
  let last = -1;
  for (let i = 0; i < 400; i++) {
    b.sync();
    const now = document.querySelectorAll('[data-vecto-content]').length;
    if (now === last) break;
    last = now;
  }
  const carriers = document.querySelectorAll('[data-vecto-content]').length;

  s.disableSettledFastPath = !fastPath;
  // One untimed pass so the arm's own first-call effects (IC warmup, and for the
  // fast path the first parent-transform memo fill) are not in the samples.
  b.sync();

  const samples: number[] = [];
  for (let t = 0; t < TRIALS; t++) {
    const t0 = performance.now();
    b.sync();
    void document.body.offsetHeight;
    samples.push(performance.now() - t0);
  }
  b.destroy();
  return { ms: median(samples), carriers };
}

async function main(): Promise<void> {
  await awaitStart();
  const refreshHz = await calibrateRefreshRate();
  const frameBudgetMs = 1000 / refreshHz;
  const startedAt = performance.now();
  const rows: Array<Record<string, number | boolean>> = [];

  for (const n of BLOCK_COUNTS) {
    // Interleaved, and baseline first: a single ordering would let any thermal or
    // GC drift over the run masquerade as the effect being measured.
    const off = settledSyncMs(n, false);
    const on = settledSyncMs(n, true);
    const off2 = settledSyncMs(n, false);
    const baselineMs = Math.min(off.ms, off2.ms);
    rows.push({
      blocks: n,
      residentCarriers: on.carriers,
      settledSyncBaselineMs: +baselineMs.toFixed(4),
      settledSyncFastPathMs: +on.ms.toFixed(4),
      speedup: +(baselineMs / Math.max(on.ms, 1e-6)).toFixed(1),
      baselineFrameSharePct: +((baselineMs / frameBudgetMs) * 100).toFixed(1),
      fastPathFrameSharePct: +((on.ms / frameBudgetMs) * 100).toFixed(1),
      baselineRepeatSpreadPct: +(
        (Math.abs(off.ms - off2.ms) / Math.max(baselineMs, 1e-6)) *
        100
      ).toFixed(1),
    });
  }

  const result = await reportResult({
    name: 'settled-projection-walk',
    params: {
      BLOCK_COUNTS,
      TRIALS,
      VIEW_W,
      VIEW_H,
      CARRIER_MARGIN,
      semanticMargin: 'Infinity',
      refreshHz: +refreshHz.toFixed(2),
      frameBudgetMs: +frameBudgetMs.toFixed(4),
    },
    rows,
    durationMs: +(performance.now() - startedAt).toFixed(1),
  });
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(result, null, 2);
  document.body.appendChild(pre);
}

main().catch((error) => reportFailure('settled-projection-walk', error));
