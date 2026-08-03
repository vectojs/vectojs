// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { IRenderer } from '@vectojs/core';
import { codeAtlas, codeAtlasStats, type CodeBlock, Markdown } from '../src/Markdown';

/**
 * The atlas is selected per render from the renderer's own pixel ratio, so a
 * zoom must hand the code grid an atlas rasterized at the *new* ratio rather than
 * resampling the old one.
 *
 * Regression cover for the defect measured in Firefox 153: `codeGlyphAtlas()` was
 * a module-level singleton capturing `devicePixelRatio` at first use, so zooming
 * 100% → 133% left the atlas at 1.579 while the renderer moved to 2.068 and only
 * the code block went soft (peak edge contrast 171 → 139 → 73 across 100/133/500%
 * while prose held 255).
 *
 * These assert the *selection* logic — `blitScale === 1` — which is the invariant
 * the pixel defect violated. jsdom cannot rasterize, so pixel crispness itself is
 * verified on real hardware.
 */

/**
 * jsdom's `measureText` returns width 0 and no `actualBoundingBox*`, which the
 * atlas rejects as unpackable — so without deterministic metrics every `get()`
 * returns `null`, no slot is ever created, and a test asserting on atlas identity
 * would pass while exercising nothing.
 */
function stubCanvas2D(charWidth = 9, ascent = 12, descent = 4): void {
  const proto = HTMLCanvasElement.prototype as unknown as {
    getContext: (id: string) => unknown;
  };
  proto.getContext = function (id: string) {
    if (id !== '2d') return null;
    return {
      font: '',
      fillStyle: '',
      textBaseline: '',
      canvas: this,
      measureText: (t: string) => ({
        width: t.length * charWidth,
        actualBoundingBoxAscent: ascent,
        actualBoundingBoxDescent: descent,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: t.length * charWidth,
        fontBoundingBoxAscent: ascent,
        fontBoundingBoxDescent: descent,
      }),
      fillText: () => {},
      clearRect: () => {},
      save: () => {},
      restore: () => {},
      translate: () => {},
      scale: () => {},
    };
  } as never;
}

/** A renderer that blits and reports a settable backing-store ratio. */
function fakeRenderer(pixelRatio: number): IRenderer & { pixelRatio: number } {
  const noop = () => {};
  return {
    kind: 'canvas2d',
    pixelRatio,
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
    drawImageRect: noop,
    fill: noop,
    stroke: noop,
    fillText: noop,
    fillCircle: noop,
    flush: noop,
    createLinearGradient: () => ({}) as never,
  } as unknown as IRenderer & { pixelRatio: number };
}

const CODE = 'const answer = 42;\nreturn answer;';

/**
 * A real `CodeBlock` carrying the real default theme, taken from a rendered
 * document rather than constructed directly — the theme whose `font` and `colour`
 * the atlas keys slots on is the document's, so building one by hand would
 * exercise a different key space than production does.
 */
function codeBlock(): CodeBlock {
  const md = new Markdown('```ts\n' + CODE + '\n```', { maxWidth: 400 });
  return md.content.children[0] as CodeBlock;
}

describe('code glyph atlas DPR tracking', () => {
  beforeEach(() => {
    stubCanvas2D();
  });

  it('rasterizes at the renderer ratio, so blitScale is 1', () => {
    const block = codeBlock();
    const r = fakeRenderer(2);
    block.render(r);
    const atlas = codeAtlas();
    expect(atlas).not.toBeNull();
    expect(atlas!.pixelRatio).toBe(2);
    expect(r.pixelRatio / atlas!.pixelRatio).toBe(1);
  });

  it('follows a DPR change without a reload and without resetting the old atlas', () => {
    const block = codeBlock();
    block.render(fakeRenderer(1.579));
    const before = codeAtlas()!;
    expect(before.pixelRatio).toBe(1.579);
    const resetsBefore = before.stats.resets;

    // The zoom. Previously this kept blitting `before` at blitScale 1.31.
    const zoomed = fakeRenderer(2.068);
    block.render(zoomed);
    const after = codeAtlas()!;

    expect(after).not.toBe(before);
    expect(after.pixelRatio).toBe(2.068);
    expect(zoomed.pixelRatio / after.pixelRatio).toBe(1);
    // Keying rather than mutating is what makes this a *swap*: the old atlas keeps
    // its slots, so zooming back does not re-rasterize.
    expect(before.stats.resets).toBe(resetsBefore);
    expect(before.stats.size).toBeGreaterThan(0);
  });

  it('reuses the original atlas when the zoom is undone', () => {
    const block = codeBlock();
    block.render(fakeRenderer(1.5));
    const original = codeAtlas()!;
    const missesAfterFirstPaint = original.stats.misses;

    block.render(fakeRenderer(3));
    expect(codeAtlas()).not.toBe(original);

    block.render(fakeRenderer(1.5));
    expect(codeAtlas()).toBe(original);
    // Every glyph was already resident, so returning cost no rasterization.
    expect(original.stats.misses).toBe(missesAfterFirstPaint);
  });

  it('evicts and destroys the least recently used atlas beyond the pool bound', () => {
    const block = codeBlock();
    block.render(fakeRenderer(1));
    const first = codeAtlas()!;
    block.render(fakeRenderer(2));
    const second = codeAtlas()!;
    // A third distinct ratio evicts `first`, whose canvas is ~16 MB.
    block.render(fakeRenderer(4));
    const third = codeAtlas()!;

    expect(third).not.toBe(first);
    expect(third).not.toBe(second);
    // `destroy()` drops slots and the backing canvas.
    expect(first.stats.size).toBe(0);
    expect(first.source).toBeNull();
    // The still-pooled one is untouched.
    expect(second.stats.size).toBeGreaterThan(0);

    // Returning to the evicted ratio builds a fresh atlas rather than reviving it.
    block.render(fakeRenderer(1));
    expect(codeAtlas()).not.toBe(first);
    expect(codeAtlas()!.pixelRatio).toBe(1);
  });

  it('is not capped at 3, so a 500%-zoom ratio is matched exactly', () => {
    const block = codeBlock();
    // The measured ratio at 500% browser zoom on the 240 Hz panel.
    const r = fakeRenderer(4.286);
    block.render(r);
    // The old `Math.min(dpr, 3)` cap made this 3, a permanent 1.43x resample that
    // no rebuild path could have fixed.
    expect(codeAtlas()!.pixelRatio).toBe(4.286);
    expect(r.pixelRatio / codeAtlas()!.pixelRatio).toBe(1);
  });

  it('falls back to the window ratio for a renderer that reports none', () => {
    (window as unknown as { devicePixelRatio: number }).devicePixelRatio = 2.5;
    const block = codeBlock();
    const r = fakeRenderer(1) as unknown as { pixelRatio?: number };
    delete r.pixelRatio;
    block.render(r as unknown as IRenderer);
    expect(codeAtlas()!.pixelRatio).toBe(2.5);
  });

  it('reports stats for the atlas actually in use after a zoom', () => {
    const block = codeBlock();
    block.render(fakeRenderer(1.25));
    block.render(fakeRenderer(2.75));
    expect(codeAtlasStats()).toEqual(codeAtlas()!.stats);
  });

  it('stays on fillText for a renderer that cannot blit a sub-rect', () => {
    const block = codeBlock();
    const r = fakeRenderer(2) as unknown as { drawImageRect?: unknown };
    delete r.drawImageRect;
    const before = codeAtlas();
    block.render(r as unknown as IRenderer);
    // No atlas was selected, so the last-used one is unchanged (an SVG export
    // must not silently start blitting).
    expect(codeAtlas()).toBe(before);
  });
});
