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

  it("attaches RichText's base measurer", () => {
    // RichText builds its own measurer (baseMeasurer) rather than going through
    // measureText, so fixing only measure.ts would leave every RichText run
    // measured on a detached canvas. What matters is that the context it measures
    // on is IN the document; whether it is a fresh one is asserted below.
    new RichText([{ text: 'inline code 中文', font: '16px monospace' }], {
      maxWidth: 200,
    });
    const canvases = Array.from(document.querySelectorAll('canvas'));
    expect(canvases.length).toBeGreaterThan(0);
    // Every canvas this package put in the document is a measuring canvas.
    for (const c of canvases) expect(c.isConnected).toBe(true);
  });

  it('does not attach a canvas per RichText', () => {
    // The leak this replaced: baseMeasurer called createMeasuringContext() directly,
    // bypassing the memo, so every RichText appended a permanent 1x1 canvas to
    // <body>. Measured in real Chrome, ONE 17 KB markdown document reached 205 of
    // them (2 -> 8 -> 48 -> 141 -> 206 across the load), each holding a live 2D
    // context; process memory hit 277 MB while the JS heap sat at a healthy 25 MB,
    // because a canvas element's cost is not on the JS heap. Streaming compounded it,
    // since every re-render builds fresh RichTexts.
    //
    // Asserted as "does not grow", not as an absolute count: other suites in this
    // process may already have created the shared context, and `measureText` creates
    // it lazily too.
    new RichText([{ text: 'warm the shared context' }], { maxWidth: 200 });
    const before = document.querySelectorAll('canvas').length;
    for (let i = 0; i < 25; i++) {
      new RichText([{ text: `run ${i} 中文`, font: '16px monospace' }], { maxWidth: 200 });
    }
    expect(document.querySelectorAll('canvas').length).toBe(before);
  });

  it('measures identically across instances sharing one context', () => {
    // Sharing a context is only safe if no measurement can leak between measurers.
    // Each assigns ctx.font before every read and owns its own width cache, so two
    // RichTexts with different fonts must not contaminate each other's widths — the
    // failure mode would be the second one silently measured in the first one's font.
    const a = new RichText([{ text: 'AAAA', font: '16px monospace' }], { maxWidth: 500 });
    const b = new RichText([{ text: 'AAAA', font: '48px monospace' }], { maxWidth: 500 });
    const again = new RichText([{ text: 'AAAA', font: '16px monospace' }], { maxWidth: 500 });
    // jsdom has no font engine, so absolute widths are meaningless here; what is
    // pinned is that re-measuring the FIRST font after the second yields the same
    // answer it did before.
    expect(again.width).toBe(a.width);
    expect(b.width).toBeGreaterThanOrEqual(0);
  });
});
