// CTX-0028 — @vectojs/ui hot-path scaling.
//
// Two independent per-frame costs that grew with content:
//
//   A. VirtualList row math. `_totalH`/`_rowTop`/`_visibleRange` were O(items)
//      and run every scroll frame. Replaced with a Fenwick prefix-sum
//      (`RowHeights`): total() O(1), prefix()/indexAt() O(log n). We A/B the new
//      RowHeights against an embedded LINEAR-SCAN reference (the old algorithm)
//      over the same random height profile, timing the per-frame query set
//      (total + a prefix + an indexAt).
//
//   B. RichText.render/getContentProjection. visualLineGroups() rebuilt an
//      O(glyphs) grouping (with Math.max(...map()) per line) on every frame.
//      Now memoized on layout-result identity. We measure COLD (first call,
//      builds) vs WARM (memoized) getContentProjection() cost.
//
// Posts JSON to /results (browser-bench contract).
import { RichText, RowHeights } from '@vectojs/ui';

const p = new URLSearchParams(location.search);
const LIST_NS = (p.get('listNs') ?? '1000,10000,100000,500000').split(',').map(Number);
const RICH_GLYPHS = (p.get('richGlyphs') ?? '500,2000,8000').split(',').map(Number);
const TRIALS = Number(p.get('trials') ?? 20);
const FRAMES = Number(p.get('frames') ?? 200); // simulated scroll frames per trial

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0x100000000);
}

// The pre-fix O(n) row math, kept here purely as the benchmark A/B reference.
class LinearHeights {
  private heights: number[];
  constructor(n: number, est: number) {
    this.heights = Array.from({ length: n }, () => est);
  }
  set(i: number, h: number) {
    this.heights[i] = h;
  }
  total(): number {
    let h = 0;
    for (let i = 0; i < this.heights.length; i++) h += this.heights[i]!;
    return h;
  }
  prefix(index: number): number {
    let y = 0;
    for (let i = 0; i < index; i++) y += this.heights[i]!;
    return y;
  }
  indexAt(y: number): number {
    let acc = 0;
    for (let i = 0; i < this.heights.length; i++) {
      if (acc + this.heights[i]! > y) return i;
      acc += this.heights[i]!;
    }
    return this.heights.length - 1;
  }
}

function seedHeights<T extends { set(i: number, h: number): void }>(
  store: T,
  n: number,
  seed: number,
) {
  const rand = rng(seed);
  for (let k = 0; k < Math.min(n, 2000); k++) {
    store.set(Math.floor(rand() * n), 10 + Math.floor(rand() * 40));
  }
}

function median(xs: number[]): number {
  xs.sort((a, b) => a - b);
  return xs[Math.floor(xs.length / 2)]!;
}

function benchList(n: number) {
  // Simulate FRAMES scroll positions; each frame runs the query set a
  // VirtualList does: total() + prefix(start) + indexAt(top) + indexAt(bot).
  const fen = new RowHeights(n, 20);
  const lin = new LinearHeights(n, 20);
  seedHeights(fen, n, 1);
  seedHeights(lin, n, 1);
  const total = fen.total();
  const positions = Array.from({ length: FRAMES }, (_, i) => (total * i) / FRAMES);

  const timeOne = (store: {
    total(): number;
    prefix(i: number): number;
    indexAt(y: number): number;
  }) => {
    const ts: number[] = [];
    for (let t = 0; t < TRIALS; t++) {
      const t0 = performance.now();
      for (const y of positions) {
        store.total();
        const start = store.indexAt(y);
        store.prefix(start);
        store.indexAt(y + 700);
      }
      ts.push(performance.now() - t0);
    }
    return median(ts);
  };

  const fenMs = timeOne(fen);
  const linMs = timeOne(lin);
  return {
    items: n,
    fenwickMs: +fenMs.toFixed(4),
    linearScanMs: +linMs.toFixed(4),
    speedup: +(linMs / fenMs).toFixed(2),
  };
}

function benchRich(glyphs: number) {
  const text = 'lorem ipsum dolor '.repeat(Math.ceil(glyphs / 18)).slice(0, glyphs);
  const coldTs: number[] = [];
  const warmTs: number[] = [];
  for (let t = 0; t < TRIALS; t++) {
    const rt = new RichText([{ text }], { maxWidth: 600 });
    // COLD: first projection builds the visual line groups.
    let t0 = performance.now();
    rt.getContentProjection();
    coldTs.push(performance.now() - t0);
    // WARM: subsequent frames hit the memo (simulate FRAMES render calls).
    t0 = performance.now();
    for (let f = 0; f < FRAMES; f++) rt.getContentProjection();
    warmTs.push((performance.now() - t0) / FRAMES);
  }
  const cold = median(coldTs);
  const warm = median(warmTs);
  return {
    glyphs,
    coldMs: +cold.toFixed(4),
    warmMedianMsPerFrame: +warm.toFixed(5),
    speedup: +(cold / Math.max(warm, 1e-6)).toFixed(1),
  };
}

async function main() {
  const engine = /firefox/i.test(navigator.userAgent) ? 'firefox' : 'chrome';
  const list = LIST_NS.map(benchList);
  const rich = RICH_GLYPHS.map(benchRich);
  const payload = {
    name: 'ui-perf',
    engine,
    userAgent: navigator.userAgent,
    params: { LIST_NS, RICH_GLYPHS, TRIALS, FRAMES },
    virtualListRowMath: list,
    richTextProjection: rich,
  };
  try {
    await fetch('/results', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // ignore — table still shown below
  }
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(payload, null, 2);
  document.body.appendChild(pre);
}

main();
