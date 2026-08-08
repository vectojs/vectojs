// Task 4 (CTX-0252) — per-primitive path audit.
//
// TODO.md names two patterns to look for and demands measurement before any code
// is written: "per-call LRU bookkeeping above roughly 10k calls/frame and
// per-primitive temporaries in Canvas2D batches and UI text runs. Measure before
// replacing either pattern."
//
// A survey of every cache and every per-glyph loop in the render path found four
// live instances, and this benchmark measures each one as a SHARE of the real
// path that contains it. Shares, not totals, because a 3ms saving is worth
// nothing if the enclosing path costs 900ms and everything if it costs 4ms.
//
// The four:
//
//   A. `measureText` (packages/ui/src/measure.ts:200-208) promotes on every cache
//      HIT with `delete` + re-`set`, and builds a template-literal key
//      (`${font} ${text}`) per call. Called per run and, on the non-coalescible
//      fallback, per glyph.
//
//   B. `RichText.render()` (packages/ui/src/RichText.ts:886) calls `nodeFont()`
//      per glyph per frame, which allocates `${italic}${bold}${size}px ${family}`
//      (RichText.ts:660) only to compare it for equality against `runFont` and,
//      for the overwhelming majority of glyphs, discard it.
//
//   C. `GlyphRasterAtlas.get()` (packages/core/src/renderer/GlyphRasterAtlas.ts:222)
//      concatenates `font + '\0' + color + '\0' + glyph` before the hit check, so
//      the ~100% hit steady state allocates one key string per drawn glyph.
//
//   D. CONTROL: `parseColorToRGBA` already REMOVED its promotion and recorded the
//      reason (colorParse.ts:88-94: "measured 11.9ms vs 0.5ms per 24,800 calls
//      (23x)"). Re-measuring the promote-vs-FIFO shape here is the control that
//      says whether this harness can resolve the effect at all. If the control
//      cannot reproduce a known 23x, no null result from A-C is trustworthy.
//
// Deliberately NOT measured: `CanvasRenderer`'s circle batch allocates nothing
// per item (it accumulates into the native Canvas2D path object, with four scalar
// fields of batch state and no JS-side item list), so the "per-primitive
// temporaries in Canvas2D batches" half of the TODO entry has no target to
// measure. That is a finding, not an omission.
import { GlyphRasterAtlas } from '@vectojs/core';
import type { IRenderer } from '@vectojs/core';
import type { StyledSpan } from '@vectojs/text';
import { measureText, RichText } from '@vectojs/ui';
import { awaitStart, reportFailure, reportResult } from '../_shared/client.ts';
import { median } from '../_shared/stats.ts';

const p = new URLSearchParams(location.search);
/**
 * Glyph counts to sweep. 24,800 is not arbitrary: it is the exact call count
 * `colorParse.ts` measured its 23x promotion cost over, so the control arm is
 * directly comparable to the recorded figure.
 */
const GLYPHS = (p.get('glyphs') ?? '2000,8000,24800').split(',').map(Number);
const TRIALS = Number(p.get('trials') ?? 15);
/** Frames of `render()` per trial, so a per-frame cost is what gets reported. */
const FRAMES = Number(p.get('frames') ?? 30);
const FONT = '16px sans-serif';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0x100000000);
}

const WORDS = [
  'layout',
  'engine',
  'glyph',
  'measure',
  'render',
  'primitive',
  'batch',
  'cache',
  'promotion',
  'allocation',
  'temporary',
  'canvas',
  'atlas',
  'projection',
  'streaming',
];

/**
 * A transcript-shaped styled document of roughly `targetGlyphs` glyphs.
 *
 * Styled runs every ~11th word, so `render()`'s coalescing key actually breaks
 * runs and `nodeFont` sees more than one distinct value — the degenerate
 * single-style case would make arm B look free for the wrong reason.
 */
function makeSpans(targetGlyphs: number): StyledSpan[] {
  const rand = rng(0x9e37);
  const spans: StyledSpan[] = [];
  let glyphs = 0;
  let buf = '';
  let w = 0;
  while (glyphs < targetGlyphs) {
    const word = WORDS[Math.floor(rand() * WORDS.length)];
    glyphs += word.length + 1;
    if (w > 0 && w % 11 === 0) {
      spans.push({ text: buf });
      buf = '';
      spans.push({
        text: `${word} `,
        style: rand() < 0.5 ? { bold: true } : { italic: true },
      });
    } else {
      buf += `${word} `;
    }
    w++;
  }
  if (buf) spans.push({ text: buf });
  return spans;
}

/**
 * A renderer that records call counts and does no drawing.
 *
 * `render()`'s own cost is what arm B is a share of, so the backend must not be
 * in the measurement — a real `CanvasRenderer` would swamp the JS path with
 * rasterization and make every share look like zero. The counters double as
 * evidence: `texts` vs glyph count is how effective run coalescing actually is,
 * which decides whether the per-glyph path is even the common case.
 */
interface StubCounters {
  texts: number;
  fills: number;
  strokes: number;
  circles: number;
}

function makeStubRenderer(): { renderer: IRenderer; counters: StubCounters } {
  const counters: StubCounters = { texts: 0, fills: 0, strokes: 0, circles: 0 };
  const noop = () => {};
  const renderer = {
    kind: 'stub',
    pixelRatio: 1,
    clear: noop,
    save: noop,
    restore: noop,
    translate: noop,
    scale: noop,
    rotate: noop,
    setGlobalAlpha: noop,
    clip: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    bezierCurveTo: noop,
    closePath: noop,
    arc: noop,
    roundRect: noop,
    drawImage: noop,
    flush: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    fill: () => {
      counters.fills++;
    },
    stroke: () => {
      counters.strokes++;
    },
    fillText: () => {
      counters.texts++;
    },
    fillCircle: () => {
      counters.circles++;
    },
  };
  return { renderer: renderer as unknown as IRenderer, counters };
}

/**
 * Arm D (CONTROL) — can this harness resolve a promote-vs-FIFO difference?
 *
 * Replicates both cache shapes over the same key sequence: `promote` does the
 * `delete` + re-`set` pair on every hit exactly as `measure.ts` does, `fifo`
 * only reads exactly as `colorParse.ts` does. `colorParse` recorded 23x for this
 * shape at 24,800 calls; if this arm does not reproduce a large ratio, the null
 * results below mean nothing.
 */
function benchPromotionShape(keys: string[]): {
  promoteMs: number;
  fifoMs: number;
} {
  const promoteTs: number[] = [];
  const fifoTs: number[] = [];
  // Repeat the sequence until the timed section is comfortably above the timer
  // floor. Firefox clamps `performance.now()` to ~20 us, so a 0.02 ms reading is
  // ONE tick — indistinguishable from zero, and a ratio built on it is noise. An
  // earlier version of this arm reported exactly that.
  const reps = Math.max(1, Math.ceil(20000 / keys.length));

  for (let t = 0; t < TRIALS; t++) {
    {
      const m = new Map<string, number>();
      for (let i = 0; i < keys.length; i++) m.set(keys[i], i);
      let sink = 0;
      const t0 = performance.now();
      for (let rep = 0; rep < reps; rep++) {
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i];
          const hit = m.get(k);
          if (hit !== undefined) {
            // The pattern under test: promote to most-recently-used.
            m.delete(k);
            m.set(k, hit);
            sink += hit;
          }
        }
      }
      promoteTs.push((performance.now() - t0) / reps);
      if (sink < 0) throw new Error('unreachable');
    }
    {
      const m = new Map<string, number>();
      for (let i = 0; i < keys.length; i++) m.set(keys[i], i);
      let sink = 0;
      const t0 = performance.now();
      for (let rep = 0; rep < reps; rep++) {
        for (let i = 0; i < keys.length; i++) {
          const hit = m.get(keys[i]);
          if (hit !== undefined) sink += hit;
        }
      }
      fifoTs.push((performance.now() - t0) / reps);
      if (sink < 0) throw new Error('unreachable');
    }
  }
  return { promoteMs: median(promoteTs), fifoMs: median(fifoTs) };
}

/**
 * Arm A — the real `measureText` hit path against the two candidate fixes.
 *
 * `realMs` is the production function over a hot working set, so every call is a
 * hit — the steady state the LRU exists to serve.
 *
 * The first version of this arm measured `keyOnly` and `getOnly` as isolated
 * fragments and left ~85% of the hit path unattributed, which cannot justify a
 * change. So instead each variant is a FAITHFUL REPLICA of the whole hit path
 * with exactly one thing altered, and `replicaCurrentMs / realMs` validates that
 * the replica is honest before any delta is believed:
 *
 *   replicaCurrent — key build + get + delete + set, i.e. today's code
 *   replicaNoPromote — key build + get only (drops the delete+set pair)
 *   replicaNested — Map<font, Map<text, width>>, no key string at all, and the
 *     outer lookup stays INSIDE the loop because a real `measureText(text, font)`
 *     cannot hoist it: only a caller that knows the font is loop-invariant could,
 *     and `measureText`'s signature does not let it know that.
 */
function benchMeasureTextHits(words: string[]): {
  realMs: number;
  replicaCurrentMs: number;
  replicaNoPromoteMs: number;
  replicaNestedMs: number;
} {
  // Warm the production cache so the timed loop is all hits. The working set is
  // deliberately under the 1000-entry cap, or eviction would turn hits into
  // misses and this would measure canvas `measureText` instead.
  for (const w of words) measureText(w, FONT);

  const realTs: number[] = [];
  const currentTs: number[] = [];
  const noPromoteTs: number[] = [];
  const nestedTs: number[] = [];

  for (let t = 0; t < TRIALS; t++) {
    {
      let sink = 0;
      const t0 = performance.now();
      for (let i = 0; i < words.length; i++) sink += measureText(words[i], FONT);
      realTs.push(performance.now() - t0);
      if (sink < 0) throw new Error('unreachable');
    }
    // Each replica gets a freshly populated map, so all three see the same
    // insertion-order state rather than whatever the previous variant left.
    {
      const m = new Map<string, number>();
      for (let i = 0; i < words.length; i++) m.set(`${FONT} ${words[i]}`, i);
      let sink = 0;
      const t0 = performance.now();
      for (let i = 0; i < words.length; i++) {
        const key = `${FONT} ${words[i]}`;
        const hit = m.get(key);
        if (hit !== undefined) {
          m.delete(key);
          m.set(key, hit);
          sink += hit;
        }
      }
      currentTs.push(performance.now() - t0);
      if (sink < 0) throw new Error('unreachable');
    }
    {
      const m = new Map<string, number>();
      for (let i = 0; i < words.length; i++) m.set(`${FONT} ${words[i]}`, i);
      let sink = 0;
      const t0 = performance.now();
      for (let i = 0; i < words.length; i++) {
        const hit = m.get(`${FONT} ${words[i]}`);
        if (hit !== undefined) sink += hit;
      }
      noPromoteTs.push(performance.now() - t0);
      if (sink < 0) throw new Error('unreachable');
    }
    {
      const outer = new Map<string, Map<string, number>>();
      const bucket = new Map<string, number>();
      for (let i = 0; i < words.length; i++) bucket.set(words[i], i);
      outer.set(FONT, bucket);
      let sink = 0;
      const t0 = performance.now();
      for (let i = 0; i < words.length; i++) {
        // Outer lookup inside the loop: see the doc comment above.
        const b = outer.get(FONT);
        const hit = b?.get(words[i]);
        if (hit !== undefined) sink += hit;
      }
      nestedTs.push(performance.now() - t0);
      if (sink < 0) throw new Error('unreachable');
    }
  }
  return {
    realMs: median(realTs),
    replicaCurrentMs: median(currentTs),
    replicaNoPromoteMs: median(noPromoteTs),
    replicaNestedMs: median(nestedTs),
  };
}

/**
 * Arm B — `RichText.render()` per frame, and the per-glyph font-string cost.
 *
 * `renderMs` is the real thing. `fontStringMs` replicates `nodeFont`'s allocation
 * once per glyph over the same nodes — an UPPER BOUND on what eliminating it
 * could return, since a real fix still has to decide run continuity somehow.
 * Reported as a share of `renderMs`, which is the number that decides whether
 * the idea is worth implementing.
 */
function benchRichTextRender(spans: StyledSpan[]): {
  renderMs: number;
  fontStringMs: number;
  glyphs: number;
  texts: number;
} {
  const rt = new RichText(spans, {
    font: FONT,
    maxWidth: 720,
    selectable: true,
  });
  const { renderer, counters } = makeStubRenderer();

  // One render outside the timing so the visual-line-group memo is warm; a cold
  // first frame would measure the grouping walk, not the per-glyph path.
  rt.render(renderer);
  const perFrameTexts = counters.texts;

  const renderTs: number[] = [];
  for (let t = 0; t < TRIALS; t++) {
    const t0 = performance.now();
    for (let f = 0; f < FRAMES; f++) rt.render(renderer);
    renderTs.push((performance.now() - t0) / FRAMES);
  }

  // The nodes `render()` walks, reached through the public projection rather than
  // a private field.
  const nodes = (rt as unknown as { result: { nodes: { height: number }[] } }).result.nodes;
  const styles = (
    rt as unknown as {
      result: {
        nodes: {
          style?: { italic?: boolean; bold?: boolean; fontFamily?: string };
        }[];
      };
    }
  ).result.nodes;

  const fontTs: number[] = [];
  for (let t = 0; t < TRIALS; t++) {
    let sink = 0;
    const t0 = performance.now();
    for (let f = 0; f < FRAMES; f++) {
      for (let i = 0; i < nodes.length; i++) {
        const style = styles[i].style;
        const italic = style?.italic ? 'italic ' : '';
        const bold = style?.bold ? 'bold ' : '';
        const family = style?.fontFamily ?? 'sans-serif';
        sink += `${italic}${bold}${nodes[i].height}px ${family}`.length;
      }
    }
    fontTs.push((performance.now() - t0) / FRAMES);
    if (sink < 0) throw new Error('unreachable');
  }

  return {
    renderMs: median(renderTs),
    fontStringMs: median(fontTs),
    glyphs: nodes.length,
    texts: perFrameTexts,
  };
}

/**
 * Arm C — `GlyphRasterAtlas.get()`'s per-call key concatenation.
 *
 * `realMs` is the production `get()` over a warm atlas: the enclosing path every
 * other figure here is a share of.
 *
 * COLOR VARIES PER RUN, and that is load-bearing in two independent ways.
 *
 * First, honesty. A previous version of this arm held `color` constant, and
 * Firefox reported the nested variant at 0.08 ms per 24,800 calls — 3 ns per
 * iteration for a string concatenation plus two `Map.get`s, which is physically
 * impossible. The JIT had hoisted the loop-invariant `font + '\0' + color` and
 * its outer lookup straight out of the loop, so the arm was measuring a fix that
 * cannot exist. Varying the color defeats the hoist.
 *
 * Second, realism. The actual caller is a syntax-highlighted code block
 * (`markdown-code.ts:566`), where color changes per token and holds for a run of
 * glyphs. A constant color would have flattered the nested shape anyway, since
 * one bucket would serve every call.
 *
 * The two replicas do the SAME work per call, which is the whole point:
 *
 *   `flatMs`   — build `font + '\0' + color + '\0' + glyph`, then one `Map.get`.
 *                A faithful replica of `GlyphRasterAtlas.ts:222-223`.
 *   `nestedMs` — build `font + '\0' + color`, look up the outer map, then one
 *                inner `Map.get`. The candidate fix's shape.
 *
 * The outer lookup stays INSIDE the loop deliberately: `get()` is a public method
 * called once per glyph and cannot cache a bucket across calls without holding
 * state that a font or color change must then invalidate.
 *
 * Note the nested shape still concatenates a key, just a per-(font, color) one
 * rather than a per-glyph one. It wins only if the shorter string is cheaper,
 * which is the hypothesis under test rather than an assumption.
 */
function benchAtlasKey(glyphs: string[]): {
  realMs: number;
  flatMs: number;
  nestedMs: number;
} {
  const atlas = new GlyphRasterAtlas({ dpr: 1, maxSize: 2048 });
  /** A theme's token palette. Realistic count; see `markdown-code.ts`. */
  const COLORS = ['#e2e8f0', '#38bdf8', '#f472b6', '#a3e635', '#fbbf24', '#94a3b8'];
  /** Glyphs per token run, so color holds for a stretch as real highlighting does. */
  const RUN = 8;
  const colorAt = (i: number): string => COLORS[Math.floor(i / RUN) % COLORS.length];

  for (let i = 0; i < glyphs.length; i++) atlas.get(FONT, colorAt(i), glyphs[i]);

  const realTs: number[] = [];
  const flatTs: number[] = [];
  const nestedTs: number[] = [];

  // Flat: exactly the production key layout.
  const flat = new Map<string, number>();
  for (let i = 0; i < glyphs.length; i++) {
    flat.set(FONT + '\u0000' + colorAt(i) + '\u0000' + glyphs[i], i);
  }
  // Nested: one inner map per (font, color) pair.
  const outer = new Map<string, Map<string, number>>();
  for (let i = 0; i < glyphs.length; i++) {
    const ok = FONT + '\u0000' + colorAt(i);
    let bucket = outer.get(ok);
    if (bucket === undefined) {
      bucket = new Map<string, number>();
      outer.set(ok, bucket);
    }
    bucket.set(glyphs[i], i);
  }

  for (let t = 0; t < TRIALS; t++) {
    {
      let sink = 0;
      const t0 = performance.now();
      for (let i = 0; i < glyphs.length; i++) {
        if (atlas.get(FONT, colorAt(i), glyphs[i]) !== null) sink++;
      }
      realTs.push(performance.now() - t0);
      if (sink < 0) throw new Error('unreachable');
    }
    {
      let sink = 0;
      const t0 = performance.now();
      for (let i = 0; i < glyphs.length; i++) {
        sink += flat.get(FONT + '\u0000' + colorAt(i) + '\u0000' + glyphs[i]) ?? 0;
      }
      flatTs.push(performance.now() - t0);
      if (sink < 0) throw new Error('unreachable');
    }
    {
      let sink = 0;
      const t0 = performance.now();
      for (let i = 0; i < glyphs.length; i++) {
        // Outer lookup per call, as a real `get()` would have to do.
        const bucket = outer.get(FONT + '\u0000' + colorAt(i));
        if (bucket !== undefined) sink += bucket.get(glyphs[i]) ?? 0;
      }
      nestedTs.push(performance.now() - t0);
      if (sink < 0) throw new Error('unreachable');
    }
  }
  return {
    realMs: median(realTs),
    flatMs: median(flatTs),
    nestedMs: median(nestedTs),
  };
}

/**
 * Arm E — the decisive arm: does dropping the promotion cost HIT RATE?
 *
 * Arms A and D price the promotion in time, but that saving is only bankable if
 * eviction quality holds, because removing the promotion turns true LRU into
 * FIFO. `colorParse.ts` asserted this was safe by ARGUMENT ("a small, stable
 * working set per scene ... evicts effectively the same entries") rather than by
 * measurement. This measures it.
 *
 * Two access patterns replayed through a bounded map at 3x the 1000-entry cap so
 * eviction actually happens — under the cap both policies are identical and the
 * question is vacuous:
 *
 *   cyclic — walk the whole universe repeatedly. The classic LRU worst case:
 *     every key comes round again exactly when it has just been evicted, so both
 *     policies should collapse. Included so a 0/0 result is recognised as the
 *     known pathology rather than mistaken for a defect in the harness.
 *   zipf — rank r drawn with probability proportional to 1/r, so a small hot head
 *     dominates. This is the shape a real font/glyph working set has, and it is
 *     the one whose delta decides the verdict.
 *
 * `missCostMs` prices a miss through the REAL `measureText` on strings never
 * measured before, so each pays canvas `measureText` plus `shapeArabic`. That
 * multiplier is what turns a hit-rate delta into a time verdict: a policy that
 * saves 30% of a hit but converts even a few percent of hits into misses is a
 * net loss.
 */
function benchEvictionQuality(): {
  cyclicLruHitRate: number;
  cyclicFifoHitRate: number;
  zipfLruHitRate: number;
  zipfFifoHitRate: number;
  missCostMs: number;
  hitCostMs: number;
} {
  const CAP = 1000;

  /** Replay `seq` through a bounded map, promoting on hit or not. */
  const replay = (seq: string[], promote: boolean): number => {
    const m = new Map<string, number>();
    let hits = 0;
    for (let i = 0; i < seq.length; i++) {
      const k = seq[i];
      const hit = m.get(k);
      if (hit !== undefined) {
        hits++;
        if (promote) {
          m.delete(k);
          m.set(k, hit);
        }
        continue;
      }
      m.set(k, i);
      if (m.size > CAP) m.delete(m.keys().next().value!);
    }
    return hits / seq.length;
  };

  // A working set 3x the cap, so ~2/3 of it cannot be resident at once.
  const universe: string[] = [];
  for (let i = 0; i < CAP * 3; i++) universe.push(`${FONT} evict-${i}`);

  const cyclic: string[] = [];
  for (let pass = 0; pass < 8; pass++) {
    for (let i = 0; i < universe.length; i++) cyclic.push(universe[i]);
  }

  const zipf: string[] = [];
  const rand = rng(0xbeef);
  for (let i = 0; i < cyclic.length; i++) {
    const r = Math.floor(Math.exp(rand() * Math.log(universe.length)));
    zipf.push(universe[Math.min(universe.length - 1, r)]);
  }

  // Price a miss and a hit through the REAL function. Each miss string is unique
  // and never measured before, so it cannot be served from the cache.
  const missTs: number[] = [];
  const hitTs: number[] = [];
  const MISS_N = 1000;
  for (let t = 0; t < TRIALS; t++) {
    const fresh: string[] = [];
    for (let i = 0; i < MISS_N; i++) fresh.push(`miss-${t}-${i}-${rand()}`);
    let sink = 0;
    const t0 = performance.now();
    for (let i = 0; i < MISS_N; i++) sink += measureText(fresh[i], FONT);
    missTs.push((performance.now() - t0) / MISS_N);
    // Immediately re-measure the same strings: now every call is a hit.
    const t1 = performance.now();
    for (let i = 0; i < MISS_N; i++) sink += measureText(fresh[i], FONT);
    hitTs.push((performance.now() - t1) / MISS_N);
    if (sink < 0) throw new Error('unreachable');
  }

  return {
    cyclicLruHitRate: replay(cyclic, true),
    cyclicFifoHitRate: replay(cyclic, false),
    zipfLruHitRate: replay(zipf, true),
    zipfFifoHitRate: replay(zipf, false),
    missCostMs: median(missTs),
    hitCostMs: median(hitTs),
  };
}

/**
 * Smallest non-zero gap `performance.now()` can report on this engine.
 *
 * Published with the results because it is the floor under every figure here.
 * Firefox clamps to ~20 us for fingerprinting resistance, so any arm whose timed
 * section lands within a few ticks of this value is reporting quantization, not
 * a measurement. Two arms of this benchmark did exactly that before the repeat
 * counts above were added.
 */
function probeTimerResolutionMs(): number {
  let smallest = Infinity;
  for (let i = 0; i < 200000; i++) {
    const a = performance.now();
    const b = performance.now();
    const d = b - a;
    if (d > 0 && d < smallest) smallest = d;
  }
  return smallest === Infinity ? 0 : smallest;
}

async function main() {
  await awaitStart();
  const startedAt = performance.now();

  const timerResolutionMs = probeTimerResolutionMs();

  // Arm E does not depend on the glyph-count axis: it is a property of the cache
  // policy and the 1000-entry cap, so it is measured once rather than per row.
  const evict = benchEvictionQuality();

  const rows = GLYPHS.map((n) => {
    const spans = makeSpans(n);

    // Distinct words for the cache arms, sized to the same axis but capped under
    // the 1000-entry LRU bound so the measured path is the hit path.
    const rand = rng(0x1234);
    const words: string[] = [];
    const wordCount = Math.min(900, Math.max(50, Math.floor(n / 8)));
    for (let i = 0; i < wordCount; i++) {
      words.push(`${WORDS[Math.floor(rand() * WORDS.length)]}${i}`);
    }
    // Repeat the working set up to `n` calls, which is the per-frame call volume
    // the TODO entry's ">10k calls/frame" threshold refers to.
    const callSeq: string[] = [];
    for (let i = 0; i < n; i++) callSeq.push(words[i % words.length]);

    const control = benchPromotionShape(callSeq.map((w) => `${FONT} ${w}`));
    const mt = benchMeasureTextHits(callSeq);
    const rich = benchRichTextRender(spans);
    const glyphChars: string[] = [];
    for (let i = 0; i < n; i++) glyphChars.push(String.fromCharCode(97 + (i % 26)));
    const atlas = benchAtlasKey(glyphChars);

    return {
      calls: n,

      // Arm D, the control. `colorParse.ts` recorded 23x at 24,800 calls.
      controlPromoteMs: +control.promoteMs.toFixed(3),
      controlFifoMs: +control.fifoMs.toFixed(3),
      controlRatio: +(control.promoteMs / Math.max(control.fifoMs, 1e-6)).toFixed(2),

      // Arm A. `replicaFidelity` must be near 1.0 for the two deltas below to
      // mean anything: it is the replica of today's code over the real thing, so
      // a value far from 1 says the replica is not measuring the same path.
      measureTextMs: +mt.realMs.toFixed(3),
      replicaCurrentMs: +mt.replicaCurrentMs.toFixed(3),
      replicaNoPromoteMs: +mt.replicaNoPromoteMs.toFixed(3),
      replicaNestedMs: +mt.replicaNestedMs.toFixed(3),
      replicaFidelity: +(mt.replicaCurrentMs / Math.max(mt.realMs, 1e-6)).toFixed(3),
      // Fraction of the CURRENT hit path each candidate fix would remove.
      noPromoteGain: +(1 - mt.replicaNoPromoteMs / Math.max(mt.replicaCurrentMs, 1e-6)).toFixed(4),
      nestedGain: +(1 - mt.replicaNestedMs / Math.max(mt.replicaCurrentMs, 1e-6)).toFixed(4),
      // Same gains expressed against the REAL function, which is what a caller
      // actually pays: the rest of `measureText` is untouched by either fix.
      noPromoteRealShare: +(
        (mt.replicaCurrentMs - mt.replicaNoPromoteMs) /
        Math.max(mt.realMs, 1e-6)
      ).toFixed(4),

      // Arm B. `texts` vs `glyphs` shows how well runs coalesce: one fillText per
      // run, so a low ratio means the per-glyph fallback is rare.
      renderMsPerFrame: +rich.renderMs.toFixed(3),
      fontStringMsPerFrame: +rich.fontStringMs.toFixed(3),
      fontStringShare: +(rich.fontStringMs / Math.max(rich.renderMs, 1e-6)).toFixed(4),
      renderGlyphs: rich.glyphs,
      renderTexts: rich.texts,
      textsPerGlyph: +(rich.texts / Math.max(rich.glyphs, 1)).toFixed(4),

      // Arm C. `flat` and `nested` do equal work per call, so `nestedGain` is
      // the honest prize; `atlasFlatShare` is how much of real `get()` the
      // key+lookup pair accounts for at all.
      atlasRealMs: +atlas.realMs.toFixed(3),
      atlasFlatMs: +atlas.flatMs.toFixed(3),
      atlasNestedMs: +atlas.nestedMs.toFixed(3),
      atlasFlatShare: +(atlas.flatMs / Math.max(atlas.realMs, 1e-6)).toFixed(4),
      atlasNestedGain: +(1 - atlas.nestedMs / Math.max(atlas.flatMs, 1e-6)).toFixed(4),
    };
  });

  const result = await reportResult({
    name: 'per-primitive-paths',
    params: { GLYPHS, TRIALS, FRAMES, FONT },
    rows,
    summary: {
      // Arm E. The decisive numbers: `noPromoteGain` above is only bankable if
      // FIFO eviction keeps the same hit rate, because a miss costs
      // `missCostMs` (real canvas measureText + shaping) against `hitCostMs`.
      evictionCyclicLruHitRate: +evict.cyclicLruHitRate.toFixed(4),
      evictionCyclicFifoHitRate: +evict.cyclicFifoHitRate.toFixed(4),
      evictionZipfLruHitRate: +evict.zipfLruHitRate.toFixed(4),
      evictionZipfFifoHitRate: +evict.zipfFifoHitRate.toFixed(4),
      missCostMs: +evict.missCostMs.toFixed(5),
      hitCostMs: +evict.hitCostMs.toFixed(5),
      timerResolutionMs: +timerResolutionMs.toFixed(5),
      missToHitRatio: +(evict.missCostMs / Math.max(evict.hitCostMs, 1e-9)).toFixed(1),
      note:
        'Shares, not totals. Two validity gates: `controlRatio` must reproduce a ' +
        'large promote-vs-FIFO ratio (colorParse.ts recorded 23x for this shape), ' +
        'and `replicaFidelity` must be near 1.0, or the replica is not measuring ' +
        'the path it claims to. Every replica keeps its outer map lookup inside ' +
        'the loop, because a per-call public method cannot hoist it.',
    },
    durationMs: +(performance.now() - startedAt).toFixed(1),
  });

  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(result, null, 2);
  document.body.appendChild(pre);
}

main().catch((error) => reportFailure('per-primitive-paths', error));
