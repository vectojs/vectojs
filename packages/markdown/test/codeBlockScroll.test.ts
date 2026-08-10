// @vitest-environment jsdom
/**
 * `CodeBlock` horizontal scrolling (CTX-0303).
 *
 * Code does not wrap: cells sit on a fixed monospace grid at `col × cellWidth`,
 * so a line wider than the box used to paint through the rounded background and
 * off the viewport edge, where no scroll and no wrap could bring the tail back.
 * Measured before the fix: 1016.984px past a 360px box.
 *
 * The load-bearing property here is **coupling**, not the offset itself. A
 * scrolled grid that moves the painted glyphs without moving the DOM selection
 * carriers by the same amount detaches selection from the text, which is exactly
 * the defect class `5cf7119` and `ee1de6f` fixed on the vertical axis. So the
 * painter and the projection must read one offset, and the tests below pin that
 * rather than trusting it.
 *
 * See `forge/decisions/code-block-overflow-2026-08.md`.
 */
import { describe, expect, it } from 'vitest';
import { CodeBlock, Markdown } from '../src/Markdown';

/** The command from the original defect report: one line, far wider than any box. */
const LONG =
  'curl -o actions-runner-linux-x64-2.317.0.tar.gz -L https://github.com/actions/runner/releases/download/v2.317.0/actions-runner-linux-x64-2.317.0.tar.gz';

/**
 * Take the CodeBlock out of a real document rather than constructing one, so the
 * resolved default theme is the one a consumer actually gets (`DEFAULT_THEME` is
 * module-private).
 */
function codeBlockFrom(source: string, maxWidth = 360, lang = 'bash'): CodeBlock {
  const md = new Markdown(`\`\`\`${lang}\n${source}\n\`\`\``, { maxWidth });
  const found = md.content.children.find((c): c is CodeBlock => c instanceof CodeBlock);
  if (!found) throw new Error('no CodeBlock in the rendered document');
  return found;
}

/** Widest projected line x, i.e. where the carriers actually sit. */
function firstLineX(block: CodeBlock): number {
  const proj = block.getContentProjection()!;
  const line = (proj.lines ?? []).find((l) => l !== undefined)!;
  return line.x;
}

describe('CodeBlock horizontal scroll', () => {
  it('reports travel for a line wider than the box', () => {
    const block = codeBlockFrom(LONG);
    // jsdom's measureText is not a real font, so the absolute figure is not
    // meaningful here — that it is positive is. The measured browser figure lives
    // in the e2e and the decision record.
    expect(block.maxScrollX).toBeGreaterThan(0);
  });

  it('reports no travel when every line fits', () => {
    const block = codeBlockFrom('ok\nshort', 800);
    expect(block.maxScrollX).toBe(0);
    // And a wheel on a block with nothing to scroll must not move it.
    block.setScrollX(200);
    expect(block.scrollX).toBe(0);
  });

  it('clamps a scroll request to the end of travel', () => {
    const block = codeBlockFrom(LONG);
    block.setScrollX(1e6);
    expect(block.scrollX).toBe(block.maxScrollX);
    block.setScrollX(-50);
    expect(block.scrollX).toBe(0);
  });

  it('moves the projected carriers by exactly the scroll offset', () => {
    // THE coupling assertion. The painter subtracts `scrollX` from each cell x;
    // if the projection did not subtract the same amount from the line x, the
    // selection highlight would sit off the glyphs by the scroll distance.
    const block = codeBlockFrom(LONG);
    const before = firstLineX(block);
    const offset = Math.min(120, block.maxScrollX);
    expect(offset).toBeGreaterThan(0);
    block.setScrollX(offset);
    expect(firstLineX(block)).toBeCloseTo(before - block.scrollX, 6);
  });

  it('keeps every projected row on the same offset', () => {
    const block = codeBlockFrom(`${LONG}\nshort line\n${LONG}`);
    block.setScrollX(80);
    const proj = block.getContentProjection()!;
    const xs = new Set((proj.lines ?? []).filter((l) => l !== undefined).map((l) => l.x));
    // One offset for the whole block: a per-row offset would shear the grid.
    expect(xs.size).toBe(1);
  });

  it('bumps the content epoch so the carriers are re-synced', () => {
    // Found in a browser, invisible to a projection-only test: Scene's content
    // sync early-returns when the content epoch AND the world transform are both
    // unchanged (Scene.ts:4288-4312). A scroll changes neither — the entity does
    // not move and its text does not change — so without a bump the painted
    // glyphs slid while the DOM selection carriers stayed exactly where they
    // were. `markDirty()` alone repaints the canvas and does NOT re-project.
    const block = codeBlockFrom(LONG);
    const before = block.getContentEpoch();
    block.setScrollX(50);
    expect(block.getContentEpoch()).not.toBe(before);

    // A no-op scroll must not bump it, or a resident block re-projects every frame.
    const settled = block.getContentEpoch();
    block.setScrollX(50);
    expect(block.getContentEpoch()).toBe(settled);
  });

  it('scrolls on a wheel and stops at the end of travel', () => {
    const block = codeBlockFrom(LONG);
    let prevented = 0;
    const wheel = (deltaX: number, deltaY = 0) => {
      block.dispatchEvent({
        type: 'wheel',
        target: block,
        deltaX,
        deltaY,
        deltaMode: 0,
        nativeEvent: { preventDefault: () => prevented++ },
      } as never);
    };

    wheel(40);
    expect(block.scrollX).toBe(40);
    expect(prevented).toBe(1);

    // A vertical wheel scrolls the code too, matching Tabs: the axis with the
    // larger magnitude wins, so a plain mouse wheel is usable.
    wheel(0, 25);
    expect(block.scrollX).toBe(65);

    // Past the end: clamps, and does NOT preventDefault, so the page keeps
    // scrolling instead of the wheel being trapped inside the code block.
    const atEnd = prevented;
    wheel(1e6);
    expect(block.scrollX).toBe(block.maxScrollX);
    wheel(1e6);
    expect(block.scrollX).toBe(block.maxScrollX);
    expect(prevented).toBe(atEnd + 1); // only the move that landed

    // And back to zero the same way.
    wheel(-1e6);
    expect(block.scrollX).toBe(0);
  });

  it('does not consume a wheel when there is nothing to scroll', () => {
    const block = codeBlockFrom('ok', 800);
    let prevented = 0;
    block.dispatchEvent({
      type: 'wheel',
      target: block,
      deltaX: 50,
      deltaY: 50,
      deltaMode: 0,
      nativeEvent: { preventDefault: () => prevented++ },
    } as never);
    expect(block.scrollX).toBe(0);
    // The page must still scroll over a code block that fits.
    expect(prevented).toBe(0);
  });

  it('converts line and page wheel deltas', () => {
    const byLine = codeBlockFrom(LONG);
    byLine.dispatchEvent({
      type: 'wheel',
      target: byLine,
      deltaX: 2,
      deltaY: 0,
      deltaMode: 1,
      nativeEvent: {},
    } as never);
    expect(byLine.scrollX).toBe(32); // 2 lines x 16px

    const byPage = codeBlockFrom(LONG);
    byPage.dispatchEvent({
      type: 'wheel',
      target: byPage,
      deltaX: 1,
      deltaY: 0,
      deltaMode: 2,
      nativeEvent: {},
    } as never);
    expect(byPage.scrollX).toBe(Math.min(byPage.maxScrollX, byPage.width));
  });

  it('clamps a stale offset when new content is shorter', () => {
    // A streamed block that replaces a long line with a short one would
    // otherwise keep an offset past the end and paint blank.
    const block = codeBlockFrom(LONG);
    block.setScrollX(block.maxScrollX);
    expect(block.scrollX).toBeGreaterThan(0);
    block.setCode('short');
    expect(block.maxScrollX).toBe(0);
    expect(block.scrollX).toBe(0);
    expect(firstLineX(block)).toBeCloseTo(block.getContentProjection()!.lines![0]!.x, 6);
  });

  it('keeps a scroll position across an append', () => {
    const block = codeBlockFrom(LONG);
    block.setScrollX(60);
    block.setCode(`${LONG}\nappended`);
    // Streaming appends to the end; the reader's horizontal position should
    // survive it rather than snapping back.
    expect(block.scrollX).toBe(60);
  });

  it('clamps on READ after the box narrows', () => {
    // `setWidth()` promises not to rebuild anything, so a now-too-large offset is
    // resolved by clamping on read instead.
    const block = codeBlockFrom(LONG, 800);
    const wide = block.maxScrollX;
    block.setScrollX(wide);
    block.setWidth(2000); // wide enough that the line fits
    expect(block.maxScrollX).toBe(0);
    expect(block.scrollX).toBe(0);
    expect(firstLineX(block)).toBe(block.getContentProjection()!.lines![0]!.x);
  });

  it('leaves height a function of line count alone', () => {
    // The invariant `setWidth()` documents and this change deliberately KEEPS:
    // the fix is a scroll region, not soft-wrap. A width change must not reflow.
    const block = codeBlockFrom(`${LONG}\n${LONG}`);
    const height = block.height;
    block.setWidth(120);
    expect(block.height).toBe(height);
    block.setWidth(4000);
    expect(block.height).toBe(height);
    // And the grid still has exactly two rows: no wrapping happened.
    expect(block.getContentProjection()!.grid!.lines.length).toBe(2);
  });

  it('clips the glyph pass to the block box', () => {
    // The clip is what stops a long line painting through the rounded background.
    // Asserted on the renderer call because nothing on the entity records it, and
    // because a stub that merely tolerates `save`/`clip` would hide its removal.
    const block = codeBlockFrom(LONG);
    const clips: number[][] = [];
    const order: string[] = [];
    block.render({
      beginPath() {},
      roundRect() {},
      fill() {},
      save() {
        order.push('save');
      },
      clip(x: number, y: number, w: number, h: number) {
        order.push('clip');
        clips.push([x, y, w, h]);
      },
      restore() {
        order.push('restore');
      },
      fillText() {
        order.push('fillText');
      },
    } as never);

    expect(clips).toEqual([[0, 0, block.width, block.height]]);
    // Clip before any glyph, restore after all of them, or the clip either does
    // nothing or leaks into whatever the scene draws next.
    expect(order[0]).toBe('save');
    expect(order[1]).toBe('clip');
    expect(order[order.length - 1]).toBe('restore');
    expect(order.filter((call) => call === 'fillText').length).toBeGreaterThan(0);
  });

  it('does not draw cells scrolled out of the box', () => {
    // The clip makes them invisible either way; skipping them keeps a wide line's
    // cost proportional to what is on screen rather than to the line.
    const block = codeBlockFrom(LONG);
    const drawnAt = (): number[] => {
      const xs: number[] = [];
      block.render({
        beginPath() {},
        roundRect() {},
        fill() {},
        save() {},
        clip() {},
        restore() {},
        fillText(_t: string, x: number) {
          xs.push(x);
        },
      } as never);
      return xs;
    };

    const unscrolled = drawnAt();
    expect(unscrolled.length).toBeGreaterThan(0);
    // Every drawn glyph is within the box, both before and after a scroll.
    for (const x of unscrolled) expect(x).toBeLessThanOrEqual(block.width);
    block.setScrollX(block.maxScrollX);
    const scrolled = drawnAt();
    expect(scrolled.length).toBeGreaterThan(0);
    for (const x of scrolled) {
      expect(x).toBeLessThanOrEqual(block.width);
      expect(x).toBeGreaterThan(-block.width);
    }
    // And the drawn window moved: scrolling to the end shows different glyphs.
    expect(scrolled).not.toEqual(unscrolled);
  });

  it('stays non-interactive so it cannot steal the selection mousedown', () => {
    // An interactive entity gets an a11y shadow node with `pointer-events: auto`
    // stacked above the transparent text mirror, which swallows the mousedown and
    // native drag-selection never starts (measured, Scene.ts:3260-3269). The
    // wheel arrives from the content-projection div instead.
    const block = codeBlockFrom(LONG);
    expect(block.interactive).toBe(false);
    expect(block.isPointInside()).toBe(false);
  });
});
