import { describe, expect, it } from 'vitest';
import { emitSVG } from '../src/emit/svg';
import { layout } from '../src/layout';

/**
 * Renderer-geometry regression tests for clipped stretchy paths (#787, #788).
 *
 * An SVG `clipPath` with the default `clipPathUnits="userSpaceOnUse"` resolves
 * in the referencing element's **post-`transform` user space**: the emitted
 * `translate(p.x p.y) scale(sx sy)` maps the clip rect again. So the window a
 * viewer actually shows is `transform ∘ rect`, not the rect as written.
 *
 * These assertions read the emitted SVG and recompute that effective window,
 * which is deterministic em math — no pixels, no browser. String-level checks
 * of the written numbers cannot see this bug class: the written values were
 * "correct" root-space intents while every rendered window was displaced.
 */

const UPEM = 1000;

interface ClipWindow {
  id: string;
  tx: number;
  ty: number;
  sx: number;
  sy: number;
  rx: number;
  ry: number;
  rw: number;
  rh: number;
  effX: number;
  effY: number;
  effW: number;
  effH: number;
}

/** Pairs every `<clipPath>` rect with its referencing path's transform. */
function clipWindows(svg: string): ClipWindow[] {
  const rects = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const m of svg.matchAll(
    /<clipPath id="(c\d+)"><rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/g,
  )) {
    rects.set(m[1], { x: +m[2], y: +m[3], w: +m[4], h: +m[5] });
  }
  const windows: ClipWindow[] = [];
  for (const m of svg.matchAll(
    /<path clip-path="url\(#(c\d+)\)" transform="translate\(([^ ]+) ([^)]+)\) scale\(([^ ]+) ([^)]+)\)"/g,
  )) {
    const r = rects.get(m[1]);
    if (!r) throw new Error(`clip-path url(#${m[1]}) has no matching clipPath rect`);
    const tx = +m[2];
    const ty = +m[3];
    const sx = +m[4];
    const sy = +m[5];
    windows.push({
      id: m[1],
      tx,
      ty,
      sx,
      sy,
      rx: r.x,
      ry: r.y,
      rw: r.w,
      rh: r.h,
      effX: tx + sx * r.x,
      effY: ty + sy * r.y,
      effW: sx * r.w,
      effH: sy * r.h,
    });
  }
  return windows;
}

describe('clipped path render windows (#787)', () => {
  /**
   * `\overbrace{x+y}` emits three overlay pieces slicing one shared brace path
   * through `.brace-left/-center/-right` windows (25% each). The pieces whose
   * alignment shifts the path origin (`xMidYMin` centre, `xMaxYMin` right)
   * carried `p.x` translations of hundreds of thousands of units while their
   * clip rects stayed at the intended container fractions, so both rendered
   * entirely off-canvas and only the left hook was visible.
   */
  it('places every overbrace piece window on its container fraction', () => {
    const { svg } = emitSVG(layout('\\overbrace{x+y}'));
    const width = emitSVG(layout('\\overbrace{x+y}')).width * UPEM;
    const wins = clipWindows(svg);

    expect(wins.length).toBe(3);
    for (const w of wins) {
      // Every piece's visible window must sit inside the formula's extent
      // (plus the viewBox pad), not hundreds of thousands of units away.
      expect(w.effX, `window ${w.id} left edge`).toBeGreaterThanOrEqual(-50);
      expect(w.effX + w.effW, `window ${w.id} right edge`).toBeLessThanOrEqual(width + 50);
    }

    // Sorted by x the three windows tile the full extent: the brace-left hook
    // starts it, the centre piece spans ~[25%, 75%], the right hook ends it.
    const sorted = [...wins].sort((a, b) => a.effX - b.effX);
    expect(sorted[0].effX).toBeLessThanOrEqual(60);
    expect(sorted[2].effX + sorted[2].effW).toBeGreaterThanOrEqual(width - 60);
    const mid = sorted[1];
    expect(mid.effX).toBeGreaterThanOrEqual(0.25 * width - 40);
    expect(mid.effX + mid.effW).toBeLessThanOrEqual(0.75 * width + 40);
  });

  /**
   * A nested `\phase` is resolved by its inner vlist against that vlist's own
   * extent, then translated by the enclosing aligned row's replay. The replay
   * shifted the resolved path but not its clip, and the post-transform clip
   * resolution squashed the window by the phase scale (s=0.7): the bar covered
   * only ~70% of `-120` from the wrong origin instead of the full row.
   */
  it('keeps a nested phase window pinned to its placement', () => {
    const { svg } = emitSVG(layout('x + \\frac{\\phase{-120}}{2}'));
    const wins = clipWindows(svg);
    expect(wins.length).toBe(1);
    const w = wins[0];

    // The recorded intent is clip == the path's own placement box, so the
    // effective window must round-trip to the transform's origin: rendering
    // must not shift or rescale what the emitter wrote.
    expect(w.effX).toBeCloseTo(w.tx, 1);
    expect(w.effY).toBeCloseTo(w.ty, 1);
    // Full-window piece: the bar spans its whole row (~2.01em), unsquashed by
    // the 0.7 scale the path itself carries.
    expect(w.effW).toBeGreaterThanOrEqual(2000);
  });
});
