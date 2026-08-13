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

  /**
   * A pure vertical wheel must scroll the PAGE, not the code.
   *
   * The handler used to take `Math.abs(deltaX) > Math.abs(deltaY) ? deltaX :
   * deltaY`, so a plain mouse wheel (deltaX 0) was consumed as horizontal
   * travel AND `preventDefault`ed — the page froze while the pointer sat over
   * any code block with overflow, and the block scrolled sideways instead.
   * Confirmed in real Chrome on a live page before the fix:
   * `{wheelDefaultPrevented: true, pageMoved: 0}`.
   *
   * A mouse with no horizontal axis is the common case, so the axis has to be
   * chosen by INTENT rather than by magnitude.
   */
  it('leaves a pure vertical wheel to the page', () => {
    const block = codeBlockFrom(LONG);
    let prevented = 0;
    block.dispatchEvent({
      type: 'wheel',
      target: block,
      deltaX: 0,
      deltaY: 120,
      deltaMode: 0,
      nativeEvent: { preventDefault: () => prevented++ },
    } as never);
    expect(block.scrollX).toBe(0);
    expect(prevented).toBe(0);
  });

  /**
   * Shift+wheel is the platform convention for horizontal scrolling with a
   * vertical-only wheel, so it stays available — and it is the reason the fix
   * reads `deltaY` at all rather than only ever using `deltaX`.
   */
  it('scrolls horizontally on shift+wheel', () => {
    const block = codeBlockFrom(LONG);
    let prevented = 0;
    block.dispatchEvent({
      type: 'wheel',
      target: block,
      deltaX: 0,
      deltaY: 30,
      deltaMode: 0,
      shiftKey: true,
      nativeEvent: { preventDefault: () => prevented++ },
    } as never);
    expect(block.scrollX).toBe(30);
    expect(prevented).toBe(1);
  });

  /**
   * A trackpad's diagonal swipe is dominated by its horizontal component when
   * the user means to scroll sideways; that must still work without shift.
   */
  it('scrolls on a horizontal-dominant trackpad swipe', () => {
    const block = codeBlockFrom(LONG);
    block.dispatchEvent({
      type: 'wheel',
      target: block,
      deltaX: 40,
      deltaY: 6,
      deltaMode: 0,
      nativeEvent: { preventDefault: () => {} },
    } as never);
    expect(block.scrollX).toBe(40);
  });

  /** Ctrl+wheel is browser zoom and must never be consumed (the `ScrollView` rule). */
  it('never consumes ctrl+wheel', () => {
    const block = codeBlockFrom(LONG);
    let prevented = 0;
    block.dispatchEvent({
      type: 'wheel',
      target: block,
      deltaX: 50,
      deltaY: 0,
      deltaMode: 0,
      ctrlKey: true,
      nativeEvent: { preventDefault: () => prevented++ },
    } as never);
    expect(block.scrollX).toBe(0);
    expect(prevented).toBe(0);
  });

  /**
   * The canvas clips its glyph pass to the block box, so the DOM copy must be
   * confined too. Without this the selection highlight over an overflowing line
   * painted past the rounded background and onto the prose beside it — measured
   * on a live page at a carrier reaching x=1580 in a 1566px viewport.
   */
  it('asks Scene to clip the projected text to the block box', () => {
    const overflowing = codeBlockFrom(LONG);
    expect(overflowing.maxScrollX).toBeGreaterThan(0);
    expect(overflowing.getContentProjection()!.clipToBounds).toBe(true);
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

/** Reads the private scrollbar wiring `render()` maintains (#527). */
interface TrackProbe {
  syncScrollTrack: () => void;
  hTrack: {
    interactive: boolean;
    x: number;
    y: number;
    width: number;
    height: number;
    emit: (event: string, payload: unknown) => void;
    getA11yAttributes: () => { role?: string };
  } | null;
  pad: number;
}

const trackProbe = (cb: CodeBlock): TrackProbe => cb as unknown as TrackProbe;

/**
 * The pointer-driven scrollbar strip (#527). Wheel-only scrolling left a
 * mouse-only reader with no way to reach a clipped tail and no indication one
 * existed; the strip fixes both. The constraint every test here respects: the
 * strip must live BELOW the last line's selection carrier, because the block's
 * own non-interactivity (see the test above) is what keeps drag-selection alive.
 */
describe('CodeBlock horizontal scroll track (#527)', () => {
  it('creates an interactive scrollbar child once the block overflows', () => {
    const block = codeBlockFrom(LONG);
    // Lazily, at render time — not in the constructor, where it would force an
    // eager grid build for blocks that may never be rendered.
    expect(trackProbe(block).hTrack).toBeNull();
    trackProbe(block).syncScrollTrack();
    const track = trackProbe(block).hTrack;
    expect(track).not.toBeNull();
    expect(track!.interactive).toBe(true);
    expect(track!.getA11yAttributes().role).toBe('scrollbar');
    // Inside the bottom padding, BELOW the last selection carrier.
    expect(track!.y).toBeGreaterThanOrEqual(block.height - trackProbe(block).pad);
    expect(track!.y + track!.height).toBeLessThanOrEqual(block.height);
  });

  it('creates no scrollbar when every line fits', () => {
    const block = codeBlockFrom('ok\nshort', 800);
    trackProbe(block).syncScrollTrack();
    expect(trackProbe(block).hTrack).toBeNull();
  });

  it('disables rather than removes the track when overflow disappears', () => {
    const block = codeBlockFrom(LONG);
    trackProbe(block).syncScrollTrack();
    expect(trackProbe(block).hTrack!.interactive).toBe(true);
    block.setWidth(100_000); // now everything fits
    trackProbe(block).syncScrollTrack();
    // Kept: the sync runs inside the scene's tree walk, and removing a child
    // mid-walk is how siblings get skipped.
    expect(trackProbe(block).hTrack).not.toBeNull();
    expect(trackProbe(block).hTrack!.interactive).toBe(false);
  });

  it('maps a full-track drag onto the full scroll travel, both ways', () => {
    const block = codeBlockFrom(LONG);
    trackProbe(block).syncScrollTrack();
    const track = trackProbe(block).hTrack!;
    expect(block.scrollX).toBe(0);
    track.emit('pointerdown', { localX: 1 }); // on the thumb (min length 24)
    track.emit('pointermove', { localX: track.width });
    expect(block.scrollX).toBe(block.maxScrollX);
    track.emit('pointermove', { localX: 1 });
    expect(block.scrollX).toBe(0);
    track.emit('pointerup', { localX: 1 });
  });

  it('jumps on a press outside the thumb', () => {
    const block = codeBlockFrom(LONG);
    trackProbe(block).syncScrollTrack();
    const track = trackProbe(block).hTrack!;
    track.emit('pointerdown', { localX: track.width }); // far right of the thumb
    expect(block.scrollX).toBe(block.maxScrollX);
    track.emit('pointerup', { localX: track.width });
  });

  it('ignores pointermove without a press, like ScrollView', () => {
    const block = codeBlockFrom(LONG);
    trackProbe(block).syncScrollTrack();
    trackProbe(block).hTrack!.emit('pointermove', { localX: 50 });
    expect(block.scrollX).toBe(0);
  });
});
