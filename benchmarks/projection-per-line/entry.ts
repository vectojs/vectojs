// CTX-0195 — per-line content-projection virtualization inside ONE tall entity.
//
// `benchmarks/content-projection/` measures the ENTITY-level gate
// (`contentProjectionMargin`), which frees whole blocks that scroll away. It
// cannot help an entity TALLER than the viewport: that entity's box always
// intersects, so `syncContentProjection` used to materialize every one of its
// lines — a `<span>` per line, and on the grid path a `<span>` per glyph
// cluster. That is the documented origin of "14.8k elements for a 346KB
// Markdown doc" (`Scene.ts:4329-4335`).
//
// Both arms run real engine code; neither simulates the window:
//   - `all`     `contentProjectionMargin: Infinity`, the documented
//               "materialize everything" escape hatch = pre-CTX-0195 behaviour
//   - `gated`   a finite margin, so Scene's per-line window applies
//
// Reports DOM element count next to sync time, because the cost being attacked
// is `createElement` volume as much as walk time.
import { Entity, Scene } from '@vectojs/core';
import { awaitStart, reportFailure, reportResult } from '../_shared/client.ts';
import { median } from '../_shared/stats.ts';

const p = new URLSearchParams(location.search);
const LINE_COUNTS = (p.get('lines') ?? '200,500,1000,2000,4000').split(',').map(Number);
/** Runs per line. Each becomes its own carrier `<span>`. */
const RUNS_PER_LINE = Number(p.get('runs') ?? 8);
const LINE_H = Number(p.get('lineH') ?? 20);
const TRIALS = Number(p.get('trials') ?? 12);
const VIEW_W = 900;
const VIEW_H = 700;

/** One tall text entity, far taller than the viewport. */
class TallTextBlock extends Entity {
  constructor(
    id: string,
    private readonly lineCount: number,
  ) {
    super(id);
    this.width = VIEW_W - 40;
    this.height = lineCount * LINE_H;
  }

  isPointInside(): boolean {
    return false;
  }

  render(): void {}

  override getContentProjection(hint?: { minY?: number; maxY?: number }) {
    // Honour the hint exactly as a real entity does (`Text`, `CodeBlock`,
    // `RichText`), so the arm measures the shipped path rather than a
    // hand-written approximation of it.
    const lines = [];
    for (let i = 0; i < this.lineCount; i++) {
      const y = i * LINE_H;
      if (
        hint?.minY !== undefined &&
        hint.maxY !== undefined &&
        (y + LINE_H < hint.minY || y > hint.maxY)
      ) {
        continue;
      }
      const runs = [];
      let text = '';
      for (let r = 0; r < RUNS_PER_LINE; r++) {
        const chunk = `w${r}`;
        runs.push({ text: chunk, x: r * 24, width: 20 });
        text += chunk;
      }
      lines.push({
        text,
        x: 4,
        y,
        baseline: 14,
        lineHeight: LINE_H,
        runs,
      });
    }
    return {
      text: lines.map((l) => l.text).join('\n'),
      font: '16px sans-serif',
      lineHeight: LINE_H,
      selectable: true,
      lines,
    };
  }
}

function makeScene(margin: number): Scene {
  const canvas = document.createElement('canvas');
  canvas.width = VIEW_W;
  canvas.height = VIEW_H;
  document.body.appendChild(canvas);
  const scene = new Scene(canvas, { contentProjectionMargin: margin });
  (scene as unknown as { isRunning: boolean }).isRunning = true;
  scene.maxFPS = 0;
  return scene;
}

function syncOnce(scene: Scene): void {
  const s = scene as unknown as {
    syncA11y: (r: unknown) => void;
    root: unknown;
  };
  s.syncA11y(s.root);
}

function measure(lineCount: number, margin: number): { ms: number; els: number } {
  const scene = makeScene(margin);
  const block = new TallTextBlock('tall', lineCount);
  // Scrolled to its middle, so the window must keep an interior band rather
  // than trivially the first screen.
  block.setPosition(20, -(lineCount * LINE_H) / 2);
  scene.add(block);

  syncOnce(scene); // warm: materialize carriers, fill caches
  const times: number[] = [];
  for (let t = 0; t < TRIALS; t++) {
    scene.markDirty();
    const t0 = performance.now();
    syncOnce(scene);
    times.push(performance.now() - t0);
  }
  const els = document.querySelectorAll('[data-vecto-content] *').length;
  scene.destroy();
  return { ms: median(times), els };
}

async function main(): Promise<void> {
  await awaitStart();
  const startedAt = performance.now();
  const rows: unknown[] = [];
  for (const n of LINE_COUNTS) {
    const all = measure(n, Number.POSITIVE_INFINITY);
    const gated = measure(n, VIEW_H);
    rows.push({
      lines: n,
      allMedianMs: +all.ms.toFixed(4),
      gatedMedianMs: +gated.ms.toFixed(4),
      speedup: +(all.ms / Math.max(1e-6, gated.ms)).toFixed(2),
      allEls: all.els,
      gatedEls: gated.els,
      elementRatio: +(all.els / Math.max(1, gated.els)).toFixed(2),
    });
  }
  const result = await reportResult({
    name: 'projection-per-line-gate',
    params: { LINE_COUNTS, RUNS_PER_LINE, LINE_H, TRIALS, VIEW_W, VIEW_H },
    rows,
    durationMs: +(performance.now() - startedAt).toFixed(1),
  });
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(result, null, 2);
  document.body.appendChild(pre);
}

main().catch((error) => reportFailure('projection-per-line-gate', error));
