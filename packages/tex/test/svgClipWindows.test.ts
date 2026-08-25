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

describe('sliced radical clip windows (#788)', () => {
  // A `\sqrt` radical is a 400em-wide path with `preserveAspectRatio slice`,
  // clipped to its declared visible box whose top edge IS the path's own
  // origin (`clip.y === p.y` at record time). SVG resolves the clip in the
  // path's post-transform user space, so if the rect were emitted verbatim in
  // root coordinates the window top would render at `ty + sy·ty` — for a
  // radical under a non-1 `sy` that displaced the window by ~1000 units and
  // ate ~33% of the ink from the wrong side (measured against the unclipped
  // variant: 1306 dark pixels vs 1943). These assertions pin the invariant
  // directly from the emitted geometry.
  const expectWindowPinnedToPlacement = (tex: string): void => {
    const { svg } = emitSVG(layout(tex));
    const wins = clipWindows(svg);
    expect(wins.length).toBe(1);
    const w = wins[0];
    // The visible window must coincide with the path's own placement box:
    // left edge on its translate x, top edge on its translate y.
    expect(w.effX).toBeCloseTo(w.tx, 1);
    expect(w.effY).toBeCloseTo(w.ty, 1);
    // The window must not be rescaled by the path's own transform beyond the
    // recorded intent: height round-trips through sy exactly.
    expect(w.effH).toBeCloseTo(w.sy * w.rh, 1);
  };

  it('pins a sliced radical under a non-1 sy', () => {
    // sy ≈ 0.99: before #793 the y-window rendered ~987 units too high.
    expectWindowPinnedToPlacement('\\sqrt{x^2+y^2}');
  });

  it('keeps a radical window glued to its origin inside an aligned fraction', () => {
    // The numerator row is replayed with dx > 0 and carries sx = sy = 0.7:
    // both coincidences that used to mask the recording gap are gone here.
    expectWindowPinnedToPlacement('\\frac{\\sqrt{x}}{y}');
  });
});
