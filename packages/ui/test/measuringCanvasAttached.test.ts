// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createMeasuringContext } from '../src/measure';
import { RichText } from '../src/RichText';

/**
 * The engine measures text on one canvas and paints it on another. Firefox
 * resolves a generic CSS family (`monospace`, `sans-serif`) through a
 * per-language font preference reachable only from a document style context, so
 * a canvas outside any document falls back to a hardcoded 0.5em advance while
 * the real, attached rendering canvas uses the user's actual font.
 *
 * Measured with `16px monospace` on `iiiiWWWW`, painted ink as ground truth
 * (`actualBoundingBoxRight` 77.2, last inked pixel x = 76):
 *
 * | document      | real canvas | appended helper | detached |
 * | ------------- | ----------- | --------------- | -------- |
 * | Firefox, lang | 76.8        | 76.8            | **64.0** |
 * | Firefox, none | 64.0        | 64.0            | 64.0     |
 * | Chromium, any | 76.8        | 76.8            | 76.8     |
 *
 * A detached measurer therefore advanced each run 20% short of the glyphs drawn
 * and the next run overlapped its tail — reported as inline code overlapping the
 * following CJK text.
 *
 * jsdom has no font engine, so these tests cannot assert widths; the real
 * numbers come from `tmp/agents/ctx-0175/probe-helper-vs-rendering.ts` against
 * both engines. What is pinned here is the structural invariant the fix rests
 * on: every measuring context the package creates is attached to the document.
 * That is exactly the property a refactor would silently drop.
 */
describe('measuring contexts are attached to the document', () => {
  it('createMeasuringContext returns a context whose canvas is in the document', () => {
    const ctx = createMeasuringContext();
    expect(ctx).not.toBeNull();
    const canvas = ctx!.canvas as HTMLCanvasElement;
    expect(canvas.isConnected).toBe(true);
    expect(document.contains(canvas)).toBe(true);
  });

  it('keeps the measuring canvas out of layout and out of the a11y tree', () => {
    // It must not perturb the page it is measured against, and it must never be
    // announced: it is an implementation detail with no semantic content.
    const canvas = createMeasuringContext()!.canvas as HTMLCanvasElement;
    expect(canvas.style.position).toBe('absolute');
    expect(canvas.style.opacity).toBe('0');
    expect(canvas.getAttribute('aria-hidden')).toBe('true');
    expect(canvas.width).toBe(1);
    expect(canvas.height).toBe(1);
  });

  it("attaches RichText's own base measurer, not just the shared one", () => {
    // RichText builds a SEPARATE per-instance measurer (baseMeasurer) rather
    // than using the module-level shared context, so fixing only measure.ts
    // would leave every RichText run still measured on a detached canvas.
    const before = document.querySelectorAll('canvas').length;
    new RichText([{ text: 'inline code 中文', font: '16px monospace' }], {
      maxWidth: 200,
    });
    const canvases = Array.from(document.querySelectorAll('canvas'));
    expect(canvases.length).toBeGreaterThan(before);
    // Every canvas this package put in the document is a measuring canvas.
    for (const c of canvases) expect(c.isConnected).toBe(true);
  });
});
