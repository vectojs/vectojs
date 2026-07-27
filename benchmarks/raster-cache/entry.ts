// CTX-0107 — is a cached-tile `drawImage` per cell cheaper than a `fillText` per
// cell, for a monospace code grid?
//
// `TextRasterCache` exists, is exported and unit-tested, and has ZERO callers.
// `CodeBlock.render` looks like its ideal customer: one `fillText` per grid cell,
// one fixed font, a small theme palette, and a mostly-ASCII glyph set — so the
// distinct `(font, color, glyph)` set is a few hundred and steady-state hit rate
// approaches 100%.
//
// The reason this needs measuring before any integration: a previous attempt to
// cut this same cost by baking the block to an offscreen surface was REJECTED
// after measuring. It cut `fillText` calls 247,380 -> 2,570 (96x) and still got
// *slower*: Chrome 502 -> 773ms, Firefox 480 -> 3,719ms. The lesson recorded from
// it was "`fillText` call count is a proxy, not the cost" — and this cache does
// not reduce the call count at all. It swaps one `fillText` for one `drawImage`
// per cell. So the entire question is the per-call cost ratio of those two
// primitives at small sizes, which is exactly what sank the bake on Firefox.
//
// Measured here at the primitive level, before touching CodeBlock:
//
//   fillText   — the status quo: one call per cell.
//   drawImage  — one blit per cell from a pre-warmed cache (hit rate 100%).
//   fillTextBaseline / drawImageBaseline — the same loops with the text content
//     varied so the cache would MISS, bounding what a low-hit-rate scene costs.
//
// A cell grid stands in for the real thing rather than mounting CodeBlock, so the
// comparison isolates the primitives from parse/highlight/grid work.
import { TextRasterCache } from '@vectojs/core';

interface Row {
  mode: string;
  cells: number;
  frames: number;
  msPerFrame: number;
  msPerCall: number;
  spreadPct: number;
  /** Median of the same samples, for comparison against the best-of figure. */
  medianMsPerFrame?: number;
  cacheHitRate?: number;
}

const p = new URLSearchParams(location.search);
const CELL_COUNTS = (p.get('cells') ?? '2000,10000,40000').split(',').map(Number);
const FRAMES = Number(p.get('frames') ?? 40);
const REPEATS = Number(p.get('repeats') ?? 9);

const VW = 1200;
const VH = 800;
const FONT = '15px ui-monospace, SFMono-Regular, Menlo, monospace';
// A realistic highlight palette: a handful of token colours, as a theme provides.
const COLORS = ['#e5e7eb', '#93c5fd', '#fca5a5', '#86efac', '#fcd34d', '#c4b5fd'];
// Printable ASCII is what code is overwhelmingly made of.
const GLYPHS =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789(){}[];=>+-*/&|.,_'.split('');

const CELL_W = 9;
const LINE_H = 24;

function reportFailure(msg: string): void {
  void fetch('/log', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ level: 'error', msg }),
  }).catch(() => {});
}
addEventListener('error', (e) => reportFailure(`uncaught: ${e.message}`));

/** Deterministic cell layout so every mode draws the identical geometry. */
function layout(cells: number): Array<{ x: number; y: number; glyph: string; color: string }> {
  const cols = Math.max(1, Math.floor((VW - 36) / CELL_W));
  const out = [];
  for (let i = 0; i < cells; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    out.push({
      x: 18 + col * CELL_W,
      // Wrap rows back into the canvas: this measures draw cost, and letting the
      // grid run off the bottom would let the rasteriser reject most of it.
      y: 18 + ((row * LINE_H) % (VH - 36)) + LINE_H * 0.75,
      glyph: GLYPHS[i % GLYPHS.length]!,
      // Colour changes every ~7 cells, not every cell: real highlighted code is
      // runs of same-coloured token text, and the renderer's fillStyle cache only
      // pays off across such runs. Cycling per cell would defeat it and flatter
      // the atlas.
      color: COLORS[Math.floor(i / 7) % COLORS.length]!,
    });
  }
  return out;
}

async function postResults(payload: unknown): Promise<void> {
  try {
    await fetch('/results', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    /* page renders the payload as a fallback */
  }
  window.close();
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/**
 * Best-of statistic: the mean of the fastest third of samples.
 *
 * The median was not good enough here. Per-arm spread came out 5-40% while the
 * effect under test is 3-33%, so nearly every comparison was swamped and the
 * two engines disagreed on the sign of the trend. Frame-draw cost has a hard
 * floor and a long right tail (GC, compositor, clock/thermal drift), so noise is
 * one-sided: it only ever makes a run slower. The fastest samples are therefore
 * the least-contaminated estimate of true cost, and averaging a few of them
 * rather than taking a single minimum keeps it from riding on one lucky outlier.
 */
function bestOf(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const take = Math.max(1, Math.floor(s.length / 3));
  let sum = 0;
  for (let i = 0; i < take; i++) sum += s[i]!;
  return sum / take;
}

async function main(): Promise<void> {
  const canvas = document.createElement('canvas');
  canvas.width = VW;
  canvas.height = VH;
  document.body.appendChild(canvas);
  const pre = document.createElement('pre');
  pre.style.cssText = 'font:12px monospace;white-space:pre-wrap';
  document.body.appendChild(pre);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('no 2d context');

  const rows: Row[] = [];

  // One atlas for every (colour, glyph) pair, shared across all cell counts: a
  // grid of fixed-size slots, so slot lookup is arithmetic rather than packing.
  const atlasKey = (color: string, glyph: string) => color + '\u0000' + glyph;
  const atlas = document.createElement('canvas');
  const atlasSlots = new Map<
    string,
    {
      sx: number;
      sy: number;
      sw: number;
      sh: number;
      w: number;
      h: number;
      offsetX: number;
      offsetY: number;
    }
  >();
  {
    const dpr = devicePixelRatio;
    const slotW = CELL_W + 8;
    const slotH = LINE_H + 8;
    const perRow = COLORS.length * 16;
    const total = GLYPHS.length * COLORS.length;
    const rowsNeeded = Math.ceil(total / perRow);
    atlas.width = Math.ceil(perRow * slotW * dpr);
    atlas.height = Math.ceil(rowsNeeded * slotH * dpr);
    const actx = atlas.getContext('2d');
    if (!actx) throw new Error('no atlas context');
    actx.scale(dpr, dpr);
    actx.font = FONT;
    actx.textBaseline = 'alphabetic';
    // Baseline sits a fixed distance down each slot; exact per-glyph metrics are
    // unnecessary because a monospace grid is uniform by construction.
    const baseline = Math.round(slotH * 0.75);
    let i = 0;
    for (const color of COLORS) {
      for (const glyph of GLYPHS) {
        const col = i % perRow;
        const row = Math.floor(i / perRow);
        const x = col * slotW;
        const y = row * slotH;
        actx.fillStyle = color;
        actx.fillText(glyph, x + 2, y + baseline);
        atlasSlots.set(atlasKey(color, glyph), {
          sx: Math.round(x * dpr),
          sy: Math.round(y * dpr),
          sw: Math.round(slotW * dpr),
          sh: Math.round(slotH * dpr),
          w: slotW,
          h: slotH,
          offsetX: 2,
          offsetY: baseline,
        });
        i++;
      }
    }
  }

  for (const cells of CELL_COUNTS) {
    const cellList = layout(cells);
    // dpr matches the display so the blit is not silently downscaled — the bake
    // attempt's cost was dominated by a DPR-scaled surface, so this must be
    // stated rather than defaulted.
    const cache = new TextRasterCache({
      dpr: devicePixelRatio,
      maxEntries: 8192,
    });

    // Warm the cache fully, so the steady-state hit rate is 100% and the
    // measurement is of blitting, not of rasterising.
    for (const c of cellList) cache.get(FONT, c.color, c.glyph);
    const warmStats = cache.stats;

    const samplesFor = new Map<string, number[]>();
    const push = (k: string, v: number) => {
      const a = samplesFor.get(k) ?? [];
      a.push(v);
      samplesFor.set(k, a);
    };

    // Interleave the modes within each cell count: running all repeats of one
    // then the other lets drift (GC, clocks) land entirely on whichever went
    // second, which previously produced an impossible negative delta in a
    // sibling benchmark.
    for (let rep = 0; rep < REPEATS; rep++) {
      // --- fillText: the status quo ---
      {
        const t0 = performance.now();
        for (let f = 0; f < FRAMES; f++) {
          ctx.fillStyle = '#0b0f19';
          ctx.fillRect(0, 0, VW, VH);
          ctx.font = FONT;
          ctx.textBaseline = 'alphabetic';
          for (const c of cellList) {
            ctx.fillStyle = c.color;
            ctx.fillText(c.glyph, c.x, c.y);
          }
        }
        push('fillText', performance.now() - t0);
      }

      // --- fillTextCached: what CanvasRenderer actually does ---
      //
      // `CanvasRenderer.fillText` caches `font` and `fillStyle` and only assigns
      // them on change (`CanvasRenderer.ts:347`). The `fillText` arm above sets
      // `fillStyle` unconditionally per cell, which overstates the baseline —
      // and therefore overstates the atlas win. This arm mirrors the real
      // renderer, so it is the honest comparison for deciding the integration.
      {
        const t0 = performance.now();
        for (let f = 0; f < FRAMES; f++) {
          ctx.fillStyle = '#0b0f19';
          ctx.fillRect(0, 0, VW, VH);
          ctx.font = FONT;
          ctx.textBaseline = 'alphabetic';
          let cachedFill = '#0b0f19';
          for (const c of cellList) {
            if (cachedFill !== c.color) {
              ctx.fillStyle = c.color;
              cachedFill = c.color;
            }
            ctx.fillText(c.glyph, c.x, c.y);
          }
        }
        push('fillTextCached', performance.now() - t0);
      }

      // --- atlas: one source canvas, blit sub-rects ---
      //
      // `TextRasterCache` allocates one canvas PER cached run, so a warm cache
      // holds 480 separate canvases and a frame blits from all of them. Chrome's
      // per-call `drawImage` cost grows with cell count (1.20 -> 2.90us) while
      // Firefox's stays flat (~0.58us), which points at per-source texture
      // pressure rather than blit cost. An atlas keeps every glyph in ONE canvas
      // and selects with the 9-argument `drawImage`, so the source texture never
      // changes. If this arm is flat on both engines, the cache's per-run-canvas
      // layout is the problem rather than the blit-instead-of-shape idea.
      {
        const t0 = performance.now();
        for (let f = 0; f < FRAMES; f++) {
          ctx.fillStyle = '#0b0f19';
          ctx.fillRect(0, 0, VW, VH);
          for (const c of cellList) {
            const slot = atlasSlots.get(atlasKey(c.color, c.glyph));
            if (slot) {
              ctx.drawImage(
                atlas,
                slot.sx,
                slot.sy,
                slot.sw,
                slot.sh,
                c.x - slot.offsetX,
                c.y - slot.offsetY,
                slot.w,
                slot.h,
              );
            }
          }
        }
        push('atlas', performance.now() - t0);
      }

      // --- drawImage from the warm cache ---
      {
        const t0 = performance.now();
        for (let f = 0; f < FRAMES; f++) {
          ctx.fillStyle = '#0b0f19';
          ctx.fillRect(0, 0, VW, VH);
          for (const c of cellList) {
            const r = cache.get(FONT, c.color, c.glyph);
            if (r) ctx.drawImage(r.canvas, c.x - r.offsetX, c.y - r.offsetY, r.width, r.height);
          }
        }
        push('drawImage', performance.now() - t0);
      }
    }

    const stats = cache.stats;
    const hitRate = stats.hits / Math.max(1, stats.hits + stats.misses);

    for (const mode of ['fillText', 'fillTextCached', 'drawImage', 'atlas'] as const) {
      const s = samplesFor.get(mode)!;
      const msTotal = bestOf(s);
      const sorted = [...s].sort((a, b) => a - b);
      rows.push({
        mode,
        cells,
        frames: FRAMES,
        msPerFrame: +(msTotal / FRAMES).toFixed(3),
        msPerCall: +((msTotal / FRAMES / cells) * 1000).toFixed(4),
        spreadPct: +((100 * (sorted.at(-1)! - sorted[0]!)) / msTotal).toFixed(1),
        // Median alongside best-of, so a reader can see how much of the spread is
        // one-sided tail rather than variance in the floor itself.
        medianMsPerFrame: +(median(s) / FRAMES).toFixed(3),
        ...(mode === 'drawImage' ? { cacheHitRate: +hitRate.toFixed(4) } : {}),
      });
    }

    rows.push({
      mode: 'cacheWarm',
      cells,
      frames: 0,
      msPerFrame: 0,
      msPerCall: 0,
      spreadPct: 0,
      cacheHitRate: +(warmStats.size / Math.max(1, warmStats.size)).toFixed(4),
    });

    pre.textContent = JSON.stringify(rows, null, 1);
    await new Promise((r) => setTimeout(r, 30));
  }

  const summary = CELL_COUNTS.map((cells) => {
    const ft = rows.find((r) => r.mode === 'fillText' && r.cells === cells)!;
    const di = rows.find((r) => r.mode === 'drawImage' && r.cells === cells)!;
    const at = rows.find((r) => r.mode === 'atlas' && r.cells === cells)!;
    const fc = rows.find((r) => r.mode === 'fillTextCached' && r.cells === cells)!;
    return {
      cells,
      fillTextMsPerFrame: ft.msPerFrame,
      fillTextCachedMsPerFrame: fc.msPerFrame,
      // The honest number: atlas versus what CanvasRenderer actually does.
      atlasVsCachedSpeedup: +(fc.msPerFrame / at.msPerFrame).toFixed(2),
      drawImageMsPerFrame: di.msPerFrame,
      atlasMsPerFrame: at.msPerFrame,
      // >1 means the cache WINS; <1 means drawImage is slower than fillText and
      // TextRasterCache must not be wired into CodeBlock.
      speedup: +(ft.msPerFrame / di.msPerFrame).toFixed(2),
      // The atlas arm isolates per-source-canvas cost from blit cost: same call
      // count, same pixels, one source texture instead of 480.
      atlasSpeedup: +(ft.msPerFrame / at.msPerFrame).toFixed(2),
      // The worst spread across the arms, so a reader can tell whether a speedup
      // clears the noise rather than reading it as exact.
      spreadPct: Math.max(ft.spreadPct, di.spreadPct, at.spreadPct),
    };
  });

  const engine = /firefox/i.test(navigator.userAgent) ? 'firefox' : 'chrome';
  const payload = {
    name: 'raster-cache-primitive',
    engine,
    userAgent: navigator.userAgent,
    params: {
      frames: FRAMES,
      repeats: REPEATS,
      cells: CELL_COUNTS,
      dpr: devicePixelRatio,
      font: FONT,
      distinctRuns: GLYPHS.length * COLORS.length,
      note: 'Primitive-level A/B, modes interleaved: one fillText per cell vs one drawImage per cell from a fully warm TextRasterCache. The cache does NOT reduce call count, so the whole question is the per-call cost ratio at small sizes.',
    },
    summary,
    rows,
  };
  pre.textContent = JSON.stringify(payload, null, 2);
  await postResults(payload);
}

// A throw here must still POST and close the window. Reporting the error without
// closing is what actually cost time: a ReferenceError in the summary — after
// every measurement had already completed — left the page open, so the runner
// waited out its whole timeout on an idle browser with the results sitting in the
// DOM. That reads exactly like a hung benchmark.
void main().catch(async (e) => {
  const msg = String(e instanceof Error ? (e.stack ?? e.message) : e);
  reportFailure(`main() threw: ${msg}`);
  await postResults({
    name: 'raster-cache-primitive',
    engine: /firefox/i.test(navigator.userAgent) ? 'firefox' : 'chrome',
    failed: true,
    error: msg,
  });
});
