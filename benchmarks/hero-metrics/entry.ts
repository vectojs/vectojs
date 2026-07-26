// CTX-0061 — the three Hero metrics that had no real-browser baseline.
//
// Table virtualization, the content-projection gate, graph3d-vs-d3 and the WASM
// transform kernel already have chrome+firefox baselines. These three did not:
//
//   1. VirtualList scroll math — Fenwick prefix/indexAt vs a linear scan over
//      every row height. The claim being checked is the per-scroll cost, so we
//      time repeated scroll resolutions, not construction.
//   2. devtools sibling-overlap audit — broad-phased vs all-pairs. Previously
//      only measured in Node, where there is no real layout/GC behaviour.
//   3. MSDF glyph→quad throughput — chars/second for MSDFFont.layout.
//
// Each measures the SAME workload both ways in the same page, so the number is a
// delta measured on one engine rather than an absolute quoted out of context.
import { Entity } from '@vectojs/core';
import { RowHeights } from '@vectojs/ui';
import { auditTree } from '@vectojs/devtools/headless';
import { MSDFFont, type MSDFFontData } from '@vectojs/text';

const p = new URLSearchParams(location.search);
const TRIALS = Number(p.get('trials') ?? 7);

const median = (xs: number[]): number => {
  xs.sort((a, b) => a - b);
  return xs[xs.length >> 1]!;
};
const time = (f: () => void): number => {
  const t0 = performance.now();
  f();
  return performance.now() - t0;
};
/** Let the compositor breathe so Chrome never shows "page unresponsive". */
const yieldToPaint = () => new Promise((r) => setTimeout(r, 0));

// ── 1. VirtualList scroll math: Fenwick vs linear prefix scan ────────────────
// `RowHeights` is exported, so the scroll math is measured directly rather than
// through the component — same code the list uses, no rendering noise.
function virtualListRows(count: number) {
  const heights = new Float64Array(count);
  for (let i = 0; i < count; i++) heights[i] = 24 + (i % 7) * 4;

  const rh = new RowHeights(count, 28);
  for (let i = 0; i < count; i++) rh.set(i, heights[i]!);
  const total = rh.total();

  // What a scroll costs: resolve the row at an offset, and that row's top edge.
  const SCROLLS = 200;
  const offsets = new Float64Array(SCROLLS);
  for (let s = 0; s < SCROLLS; s++) offsets[s] = (((s * 7919) % 1000) / 1000) * total;

  const fenwick = () => {
    let acc = 0;
    for (let s = 0; s < SCROLLS; s++) {
      const i = rh.indexAt(offsets[s]!);
      acc += rh.prefix(i);
    }
    return acc;
  };
  // The pre-Fenwick approach: sum row heights from 0 until the offset is reached.
  const linear = () => {
    let acc = 0;
    for (let s = 0; s < SCROLLS; s++) {
      const target = offsets[s]!;
      let run = 0,
        i = 0;
      for (; i < count; i++) {
        if (run + heights[i]! > target) break;
        run += heights[i]!;
      }
      acc += run;
    }
    return acc;
  };
  // Guard the premise: both must resolve to the same total.
  const same = Math.abs(fenwick() - linear()) < 1;
  const f = median(Array.from({ length: TRIALS }, () => time(fenwick)));
  const l = median(Array.from({ length: TRIALS }, () => time(linear)));
  return {
    rows: count,
    scrollsPerTrial: SCROLLS,
    agree: same,
    fenwickMs: +f.toFixed(4),
    linearMs: +l.toFixed(4),
    speedup: +(l / Math.max(f, 1e-6)).toFixed(1),
  };
}

// ── 2. devtools sibling-overlap audit: broad phase vs all-pairs ──────────────
class Box extends Entity {
  constructor(id: string, x: number, y: number, w: number, h: number) {
    super(id);
    this.setPosition(x, y);
    this.width = w;
    this.height = h;
  }
  isPointInside() {
    return false;
  }
  render() {}
}
function auditRows(count: number) {
  const parent = new Box('parent', 0, 0, 0, 0);
  for (let i = 0; i < count; i++) parent.add(new Box(`r${i}`, 0, i * 24, 300, 22));

  const broad = () => {
    auditTree(parent, null);
  };
  // Reference all-pairs, matching what auditTree used to do.
  const allPairs = () => {
    const kids = parent.children as unknown as Array<
      Entity & {
        getWorldBounds(): {
          x: number;
          y: number;
          width: number;
          height: number;
        };
      }
    >;
    let hits = 0;
    for (let i = 0; i < kids.length; i++) {
      const a = kids[i]!.getWorldBounds();
      for (let j = i + 1; j < kids.length; j++) {
        const b = kids[j]!.getWorldBounds();
        const x = Math.max(a.x, b.x),
          y = Math.max(a.y, b.y);
        if (
          Math.min(a.x + a.width, b.x + b.width) - x > 0.5 &&
          Math.min(a.y + a.height, b.y + b.height) - y > 0.5
        )
          hits++;
      }
    }
    return hits;
  };
  broad();
  allPairs();
  const bp = median(Array.from({ length: TRIALS }, () => time(broad)));
  const ap = median(Array.from({ length: TRIALS }, () => time(allPairs)));
  return {
    rows: count,
    broadPhaseMs: +bp.toFixed(3),
    allPairsMs: +ap.toFixed(3),
    speedup: +(ap / Math.max(bp, 1e-6)).toFixed(1),
  };
}

// ── 3. MSDF glyph→quad throughput ───────────────────────────────────────────
function msdfFont(): MSDFFont {
  const glyphs = [];
  for (let c = 32; c < 127; c++) {
    glyphs.push({
      unicode: c,
      advance: 0.5 + (c % 7) * 0.02,
      planeBounds: { left: 0.02, bottom: 0, right: 0.48, top: 0.7 },
      atlasBounds: {
        left: (c % 16) * 32,
        bottom: Math.floor(c / 16) * 32,
        right: (c % 16) * 32 + 30,
        top: Math.floor(c / 16) * 32 + 30,
      },
    });
  }
  const data: MSDFFontData = {
    atlas: {
      type: 'msdf',
      distanceRange: 4,
      size: 32,
      width: 512,
      height: 512,
      yOrigin: 'bottom',
    },
    metrics: { emSize: 1, lineHeight: 1.25, ascender: 0.8, descender: -0.2 },
    glyphs,
    kerning: [],
  };
  return new MSDFFont(data);
}
function msdfThroughput(reps: number) {
  const font = msdfFont();
  const para = 'The quick brown fox jumps over the lazy dog 0123456789. ';
  const text = Array.from({ length: reps }, () => para).join('\n');
  font.layout(text, 32);
  const ms = median(
    Array.from({ length: TRIALS }, () =>
      time(() => {
        font.layout(text, 32);
      }),
    ),
  );
  return {
    chars: text.length,
    ms: +ms.toFixed(3),
    charsPerSecM: +(text.length / ms / 1000).toFixed(1),
  };
}

async function main() {
  const engine = /firefox/i.test(navigator.userAgent) ? 'firefox' : 'chrome';
  const virtualList: unknown[] = [];
  for (const n of [1000, 10000, 100000]) {
    virtualList.push(virtualListRows(n));
    await yieldToPaint();
  }
  const audit: unknown[] = [];
  for (const n of [200, 1000, 4000]) {
    audit.push(auditRows(n));
    await yieldToPaint();
  }
  const msdf: unknown[] = [];
  for (const n of [1, 100, 500]) {
    msdf.push(msdfThroughput(n));
    await yieldToPaint();
  }

  const payload = {
    name: 'hero-metrics',
    engine,
    userAgent: navigator.userAgent,
    params: { TRIALS },
    virtualList,
    audit,
    msdf,
  };
  try {
    await fetch('/results', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    /* page still shows the table below */
  }
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(payload, null, 2);
  document.body.appendChild(pre);
}

main();
