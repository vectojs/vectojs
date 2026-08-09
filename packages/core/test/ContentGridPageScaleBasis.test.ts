// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { ContentProjectionManager } from '../src/tree/scene/ContentProjectionManager';
import { PhaseTimer } from '../src/tree/scene/PhaseTimer';

/**
 * The page-scale basis the grid calibration probe measures.
 *
 * Calibration recovers the page's own layout scale by reading the client
 * distance between two absolutely positioned spans, then writes every carrier a
 * `scaleX` of `advance * scale / natural`. That scale multiplies the painted
 * advance of every cell, and the browser sizes its selection rects from the
 * painted advance — so an error here does not merely look wrong, it stops
 * consecutive selection rects from tiling the grid pitch and paints a vertical
 * line at every seam.
 *
 * A browser rounds `getBoundingClientRect().left` to 1/64 of a device pixel.
 * That rounding is a fixed absolute quantum, so the shorter the basis, the larger
 * the relative error it becomes. The probe used a **1 px** basis, where the whole
 * 1/64 lands in the result: measured in real headed Chrome at
 * `devicePixelRatio` 1.1000000685 on xuepoo-blog, the 1 px basis read
 * **0.9921875** (63.5/64) on a page whose scale was **1.0**, and the resulting
 * 0.78% shortfall left a **0.133 px** gap at every CJK seam (18.0001 px of pitch
 * selected as 17.8624 px) and 0.061 px at every Latin one.
 *
 * These tests model that quantization directly — jsdom reports 0 for every rect,
 * so the rounding has to be injected — and assert the recovered scale, which is
 * the quantity the carriers actually consume.
 */

interface Rect {
  left: number;
  width: number;
}

/**
 * Drive one calibration pass with `getBoundingClientRect` quantized to 1/64
 * device px, and report the `scaleX` the pass wrote.
 *
 * @param pageScale True layout scale of the page, applied to every rect before
 *   quantization — the value calibration is supposed to recover.
 */
function calibratedScale(pageScale: number, devicePixelRatio: number): number {
  const quantum = 1 / (64 * devicePixelRatio);
  const quantize = (value: number): number => Math.round(value / quantum) * quantum;

  // Every element's client geometry derives from its own `left` and the text it
  // holds, scaled by the page and then rounded the way a browser rounds.
  const rectFor = (element: HTMLElement): Rect => {
    const left = Number.parseFloat(element.style.left || '0') || 0;
    // One monospace cell is 9 CSS px wide at this font; the natural width of a
    // measured string is its length times that. Only the probe's own text nodes
    // are measured through Range, and those are handled below.
    return { left: quantize(left * pageScale), width: 0 };
  };

  const originalElementRect = HTMLElement.prototype.getBoundingClientRect;
  const originalRangeRect = Range.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const rect = rectFor(this);
    return {
      x: rect.left,
      y: 0,
      left: rect.left,
      top: 0,
      right: rect.left + rect.width,
      bottom: 0,
      width: rect.width,
      height: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
  Range.prototype.getBoundingClientRect = function (this: Range) {
    // The natural (unscaled-by-us) laid-out width of the probe's carrier text.
    // The engine divides by this, so it must be the width at the page's scale,
    // quantized like any other rect.
    const text = this.toString();
    const natural = quantize(text.length * 9 * pageScale);
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: natural,
      bottom: 0,
      width: natural,
      height: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };

  const frames: Array<() => void> = [];
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    frames.push(() => callback(0));
    return frames.length;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;

  try {
    const a11yRoot = document.createElement('div');
    document.body.appendChild(a11yRoot);
    const manager = new ContentProjectionManager(a11yRoot, new PhaseTimer());

    const projectionRoot = document.createElement('div');
    a11yRoot.appendChild(projectionRoot);
    const line = document.createElement('span');
    line.dataset.vectoGridLine = '0';
    projectionRoot.appendChild(line);
    const cell = document.createElement('span');
    cell.dataset.vectoGridCell = '0';
    cell.dataset.vectoGridSourceLength = '1';
    // One wcwidth-2 cluster: 2 columns at a 9 px cell, the CJK case from the
    // finding. Its natural laid-out width is one 9 px advance.
    cell.dataset.vectoGridAdvance = '18';
    cell.dataset.vectoGridFont = '15px monospace';
    cell.dataset.vectoGridLineHeight = '24px';
    cell.textContent = '使';
    line.appendChild(cell);

    manager.scheduleGridCalibration('entity-1', projectionRoot, 'key-1', pageScale, 1);
    // read frame, then write frame
    while (frames.length > 0) frames.shift()!();

    const transform = cell.style.transform;
    const match = /scaleX\(([-\d.eE]+)\)/.exec(transform);
    // An unwritten transform means the pass decided the scale was within its
    // 0.001 no-op band, i.e. exactly 1.
    if (!match) return 1;
    // Recover the page scale the pass measured: it wrote
    // `advance * scale / natural`, and here natural == advance / 2 * pageScale...
    // rather than invert that, report the transform and let the caller compare
    // against the same expression computed from the true scale.
    return Number(match[1]);
  } finally {
    HTMLElement.prototype.getBoundingClientRect = originalElementRect;
    Range.prototype.getBoundingClientRect = originalRangeRect;
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCaf;
  }
}

/** The fixture cell's grid pitch and the natural width of its single glyph. */
const CELL_ADVANCE = 18;
const CELL_NATURAL = 9;

/**
 * Selection residue: grid pitch minus the advance the carrier actually paints.
 *
 * This is the quantity the artifact is made of. The browser sizes a selection
 * rect from the painted advance, so a non-zero residue is precisely the width of
 * the unhighlighted column between two adjacent cells.
 */
function selectionResidue(pageScale: number, devicePixelRatio: number): number {
  const transform = calibratedScale(pageScale, devicePixelRatio);
  return CELL_ADVANCE - CELL_NATURAL * transform;
}

describe('grid calibration page-scale basis', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  /**
   * The floor any rect-based calibration can reach: a browser reports rects
   * quantized to 1/64 device px, so measuring the cell's own natural width
   * already costs up to half a quantum. That is an inherent limit of the
   * measurement, not of the basis, and it is ~10x below the defect — the 1 px
   * basis left 0.133 px where this bound is 0.014 px.
   */
  const residueBound = (devicePixelRatio: number): number => 1 / (64 * devicePixelRatio);

  it('tiles the grid pitch on an unscaled page', () => {
    const dpr = 1.1000000685453415;
    // With the old 1 px basis the recovered scale was 0.9921875 instead of 1, so
    // this residue was 0.133 px — a full device-pixel column at this DPR.
    expect(Math.abs(selectionResidue(1, dpr))).toBeLessThan(residueBound(dpr));
  });

  it('tiles the grid pitch on a fractionally scaled page', () => {
    const dpr = 1.1000000685453415;
    for (const pageScale of [1.05, 0.93, 1.07, 1.5]) {
      expect(Math.abs(selectionResidue(pageScale, dpr))).toBeLessThan(residueBound(dpr));
    }
  });

  it('tiles the grid pitch across device pixel ratios', () => {
    for (const dpr of [1, 1.1000000685453415, 1.25, 1.5, 2, 2.799999952316284]) {
      expect(Math.abs(selectionResidue(1, dpr))).toBeLessThan(residueBound(dpr));
    }
  });
});
