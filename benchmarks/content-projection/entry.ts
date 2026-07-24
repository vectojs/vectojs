// CTX-0024 — streaming/long-document content-projection sync cost.
//
// Measures Scene's per-frame content-projection sync as the document grows,
// with the viewport gate DISABLED (contentProjectionMargin: Infinity — the
// pre-fix "materialize/compute everything" behavior) vs ENABLED (a finite
// viewport margin — the fix, which hoists the visibility gate ABOVE the
// O(glyphs) getContentProjection() call so off-viewport blocks cost O(1)).
//
// The scenario mirrors the real target: a long Markdown-like document where
// only a viewport-worth of blocks is on-screen and the rest are scrolled off.
// A `SelectableTextBlock` reports a realistic content projection whose cost is
// proportional to its glyph count (it builds a per-line/run structure and, to
// model the real RichText.getContentProjection cost, does O(glyphs) work), so
// summing sync time over all blocks is O(total glyphs) when ungated and
// O(visible glyphs) when gated. Posts JSON to /results (browser-bench
// contract) so the run needs no screenshot.
import { Scene, Entity } from '@vectojs/core';

const p = new URLSearchParams(location.search);
const BLOCK_COUNTS = (p.get('blocks') ?? '50,100,200,400,800,1600').split(',').map(Number);
const GLYPHS_PER_BLOCK = Number(p.get('glyphs') ?? 240); // ~a paragraph
const BLOCK_H = Number(p.get('blockH') ?? 60);
const TRIALS = Number(p.get('trials') ?? 12);
const VIEW_W = 900;
const VIEW_H = 700;

// A block that exposes a content projection whose build cost scales with its
// glyph count — the property that makes the ungated sync O(total glyphs).
class SelectableTextBlock extends Entity {
  private glyphCount: number;
  constructor(id: string, glyphCount: number) {
    super(id);
    this.width = VIEW_W - 40;
    this.height = BLOCK_H - 12;
    this.glyphCount = glyphCount;
  }
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
  // Cost model: O(glyphs). Mirrors RichText.getContentProjection walking every
  // glyph/run to emit positioned line data.
  override getContentProjection() {
    const runs: { text: string; x: number; width: number }[] = [];
    let acc = '';
    for (let i = 0; i < this.glyphCount; i++) {
      acc += 'x';
      if (i % 8 === 7) {
        runs.push({ text: acc, x: (i - 7) * 7, width: 8 * 7 });
        acc = '';
      }
    }
    if (acc) runs.push({ text: acc, x: 0, width: acc.length * 7 });
    return {
      text: 'x'.repeat(this.glyphCount),
      font: '16px sans-serif',
      selectable: true,
      lines: [
        {
          text: 'x'.repeat(this.glyphCount),
          x: 4,
          y: 4,
          baseline: 14,
          lineHeight: 20,
          runs,
        },
      ],
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

function buildDoc(scene: Scene, n: number): void {
  for (let i = 0; i < n; i++) {
    const b = new SelectableTextBlock(`b${i}`, GLYPHS_PER_BLOCK);
    b.setPosition(20, 10 + i * BLOCK_H); // stacked vertically → most off-screen
    scene.add(b);
  }
}

// Directly exercise the per-frame sync the render loop runs: Scene.render()
// calls `this.syncA11y(this.root)`, which walks the tree and invokes
// syncContentProjection on every node. Calling it directly isolates the
// content-projection sync cost from draw/raf so the measurement is exactly the
// path the gate optimizes (same approach as scene-hit-wasm's setup isolation).
function syncOnce(scene: Scene): void {
  const s = scene as any;
  s.syncA11y(s.root);
}

function measure(margin: number, n: number): number {
  const scene = makeScene(margin);
  buildDoc(scene, n);
  // Warm up (first sync materializes visible els + builds caches).
  syncOnce(scene);
  const times: number[] = [];
  for (let t = 0; t < TRIALS; t++) {
    // Force every block to re-evaluate its projection gate each trial.
    scene.markDirty();
    const t0 = performance.now();
    syncOnce(scene);
    times.push(performance.now() - t0);
  }
  scene.destroy();
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]!; // median
}

async function main() {
  const engine = /firefox/i.test(navigator.userAgent) ? 'firefox' : 'chrome';
  const rows: any[] = [];
  for (const n of BLOCK_COUNTS) {
    const gated = measure(VIEW_H, n); // finite margin = fix
    const ungated = measure(Infinity, n); // Infinity = pre-fix behavior
    rows.push({
      blocks: n,
      glyphsTotal: n * GLYPHS_PER_BLOCK,
      gatedMedianMs: +gated.toFixed(4),
      ungatedMedianMs: +ungated.toFixed(4),
      speedup: +(ungated / gated).toFixed(2),
    });
  }
  const payload = {
    name: 'content-projection-gate',
    engine,
    userAgent: navigator.userAgent,
    params: { BLOCK_COUNTS, GLYPHS_PER_BLOCK, BLOCK_H, TRIALS, VIEW_W, VIEW_H },
    rows,
  };
  try {
    await fetch('/results', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // ignore — the page still shows the table below
  }
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(payload, null, 2);
  document.body.appendChild(pre);
}

main();
