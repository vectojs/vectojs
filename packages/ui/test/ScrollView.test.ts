// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { type IRenderer, Entity } from '@vectojs/core';
import { DOCUMENT_SCROLL_PHYSICS, ScrollView, Text } from '../src/index';

/** A fixed-size leaf so the ScrollView has measurable content. */
class Box extends Entity {
  constructor(w: number, h: number) {
    super();
    this.width = w;
    this.height = h;
  }
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

/** Build a wheel-event stand-in that records preventDefault(). */
function wheelEvent(deltaY: number): {
  evt: { deltaY: number; preventDefault: () => void };
  pd: () => boolean;
} {
  let prevented = false;
  return {
    evt: { deltaY, preventDefault: () => (prevented = true) },
    pd: () => prevented,
  };
}

/** A pointer-event stand-in carrying a localY. */
function pointer(localY: number): {
  localY: number;
  preventDefault: () => void;
} {
  return { localY, preventDefault: () => {} };
}

/**
 * Run the spring integrator until the content settles on its target. In a real
 * Scene, `content.update()` is ticked directly by the tree walk (it's a normal
 * child node); these unit tests drive `ScrollView` in isolation, so both nodes
 * need an explicit tick.
 */
function settle(sv: ScrollView): void {
  for (let i = 0; i < 600; i++) {
    sv.update(16, i * 16);
    sv.content.update(16, i * 16);
  }
}

describe('ScrollView', () => {
  it('is an interactive, clip-children viewport sized to its box', () => {
    const sv = new ScrollView({ width: 200, height: 100 });
    expect(sv.interactive).toBe(true);
    expect(sv.clipChildren).toBe(true);
    expect(sv.width).toBe(200);
    expect(sv.height).toBe(100);
    expect(sv.getBounds()).toEqual({ x: 0, y: 0, width: 200, height: 100 });
  });

  it('nests children in the content layer and measures the content extent', () => {
    const sv = new ScrollView({ width: 200, height: 100 });
    sv.add(new Box(50, 300));
    expect(sv.content.children).toHaveLength(1);
    expect(sv.content.height).toBe(300);
    expect(sv.content.width).toBe(50);
  });

  it('scrolls the content on wheel and calls preventDefault', () => {
    const sv = new ScrollView({ width: 200, height: 100 });
    sv.add(new Box(50, 300)); // maxScroll = 300 − 100 = 200
    const { evt, pd } = wheelEvent(50);
    sv.emit('wheel', evt);
    expect(pd()).toBe(true);
    settle(sv);
    expect(sv.content.y).toBeCloseTo(-50, 0); // scrolled down by 50
  });

  it('clamps at the bottom — cannot scroll past the content end', () => {
    const sv = new ScrollView({ width: 200, height: 100 });
    sv.add(new Box(50, 300));
    sv.emit('wheel', wheelEvent(10000).evt); // far past the end
    settle(sv);
    expect(sv.content.y).toBeCloseTo(-200, 0); // clamped to −maxScroll
  });

  it('clamps at the top — cannot scroll above the start', () => {
    const sv = new ScrollView({ width: 200, height: 100 });
    sv.add(new Box(50, 300));
    sv.emit('wheel', wheelEvent(-10000).evt); // pull above the top
    settle(sv);
    expect(sv.content.y).toBeCloseTo(0, 0);
  });

  it('does not scroll when content fits inside the viewport', () => {
    const sv = new ScrollView({ width: 200, height: 100 });
    sv.add(new Box(50, 40)); // shorter than the viewport → maxScroll = 0
    sv.emit('wheel', wheelEvent(500).evt);
    settle(sv);
    expect(sv.content.y).toBeCloseTo(0, 0);
  });

  it('does not consume the wheel when content fits — the page keeps it (#525)', () => {
    // The old handler called preventDefault before asking whether there was
    // anything to scroll, so a short ScrollView turned its whole band into a
    // page-scroll dead zone: the wheel did nothing inside it and the page
    // underneath never moved.
    const sv = new ScrollView({ width: 200, height: 100 });
    sv.add(new Box(50, 40)); // shorter than the viewport → maxScroll = 0
    const { evt, pd } = wheelEvent(500);
    sv.emit('wheel', evt);
    expect(pd()).toBe(false);
  });

  it('reaches bottom content added by in-place child growth (#685)', () => {
    // updateContentSize() ran only from add()/remove(); a child growing via
    // append (streaming text) raised its own height without any mutation on
    // the ScrollView, so clamping kept capping scroll at the old extent and
    // the newly added bottom was unreachable.
    const sv = new ScrollView({ width: 200, height: 100 });
    const child = new Box(50, 140);
    sv.add(child);
    sv.emit('wheel', wheelEvent(10000).evt); // scrolled to bottom (-40)
    settle(sv);
    expect(sv.content.y).toBeCloseTo(-40, 0);

    child.height = 300; // grows IN PLACE — no add(), no updateContentSize()
    sv.update(16, 0);
    sv.content.update(16, 0);

    expect(sv.content.height).toBe(300);
    sv.emit('wheel', wheelEvent(10000).evt);
    settle(sv);
    expect(sv.content.y).toBeCloseTo(-200, 0);
  });

  it('stops scrolling into blank space after in-place child shrink (#685)', () => {
    const sv = new ScrollView({ width: 200, height: 100 });
    const child = new Box(50, 300);
    sv.add(child);
    sv.emit('wheel', wheelEvent(10000).evt); // scrolled to bottom (-200)
    settle(sv);
    expect(sv.content.y).toBeCloseTo(-200, 0);

    child.height = 120; // shrinks IN PLACE — maxScroll drops to 20
    sv.update(16, 0);
    sv.content.update(16, 0);
    settle(sv);

    expect(sv.content.y).toBeCloseTo(-20, 0);
  });

  it('re-clamps the scroll offset when content shrinks', () => {
    const sv = new ScrollView({ width: 200, height: 100 });
    const tall = new Box(50, 300);
    sv.add(tall);
    sv.emit('wheel', wheelEvent(10000).evt); // scrolled to bottom (−200)
    settle(sv);
    expect(sv.content.y).toBeCloseTo(-200, 0);

    tall.height = 120; // content now only slightly taller than the viewport
    sv.updateContentSize(); // maxScroll = 20
    settle(sv);
    expect(sv.content.y).toBeCloseTo(-20, 0);
  });

  it('drag scrolls the content (touch / mouse pointer-drag)', () => {
    const sv = new ScrollView({ width: 200, height: 100 });
    sv.add(new Box(50, 300)); // maxScroll = 200
    sv.emit('pointerdown', pointer(100));
    sv.emit('pointermove', pointer(60)); // finger up 40 → content follows up 40
    sv.emit('pointerup', pointer(60));
    settle(sv);
    expect(sv.content.y).toBeCloseTo(-40, 0);
  });

  it('ignores pointermove unless a drag is active', () => {
    const sv = new ScrollView({ width: 200, height: 100 });
    sv.add(new Box(50, 300));
    sv.emit('pointermove', pointer(60)); // no pointerdown first
    settle(sv);
    expect(sv.content.y).toBeCloseTo(0, 0);
  });

  it('clamps a drag to the content bounds', () => {
    const sv = new ScrollView({ width: 200, height: 100 });
    sv.add(new Box(50, 300));
    sv.emit('pointerdown', pointer(500));
    sv.emit('pointermove', pointer(0)); // finger up 500 → clamp to −maxScroll
    sv.emit('pointerup', pointer(0));
    settle(sv);
    expect(sv.content.y).toBeCloseTo(-200, 0);
  });

  it('provides public scrollTo and scrollToBottom APIs', () => {
    const sv = new ScrollView({ width: 200, height: 100 });
    sv.add(new Box(50, 300)); // maxScroll = 200

    sv.scrollTo(120);
    settle(sv);
    expect(sv.content.y).toBeCloseTo(-120, 0);

    sv.scrollToBottom();
    settle(sv);
    expect(sv.content.y).toBeCloseTo(-200, 0);
  });

  it('snaps scrollToBottom instantly, without spawning a spring driver', () => {
    // scrollToBottom is the auto-follow path a streaming chat calls on every
    // token (see MessageView/reflow in the chat demo) — often dozens of times
    // a second while content grows a little on each call. Retargeting a spring
    // that fast never lets it settle, so the viewport visibly jitters instead
    // of tracking the newest content. It must bypass the spring and land
    // exactly on target in the same tick, with no driver left in flight.
    const sv = new ScrollView({ width: 200, height: 100 });
    sv.add(new Box(50, 300)); // maxScroll = 200
    sv.scrollToBottom();
    expect(sv.content.y).toBeCloseTo(-200, 0);
    expect(sv.content.hasPendingAnimations()).toBe(false);
  });

  it('reports a pending animation on content while scrolling settles, and none once at rest', () => {
    // This is the mechanism the idle-throttle bug hinged on: Scene only keeps
    // rendering continuously across multiple frames via hasPendingAnimations()
    // (a markDirty() call from inside update() is wiped by the loop's own
    // dirty=false at the end of that same tick). A scroll that isn't visible
    // to hasPendingAnimations() only advances once per external trigger.
    // (Wheel/drag still spring — only scrollToBottom's auto-follow bypasses it,
    // see the test above — so a wheel scroll is what exercises this path now.)
    const sv = new ScrollView({ width: 200, height: 100 });
    sv.add(new Box(50, 300)); // maxScroll = 200
    sv.emit('wheel', wheelEvent(50).evt);
    expect(sv.content.hasPendingAnimations()).toBe(true);
    settle(sv);
    expect(sv.content.hasPendingAnimations()).toBe(false);
  });

  it('opts its semantic mirror out of pointer hit testing so content stays selectable', () => {
    // ScrollView is interactive (it needs wheel/pointer events) but draws
    // nothing, so Scene projects a viewport-sized transparent mirror for it.
    // With the inherited default that mirror is pointerEvents:'auto' and, being
    // ordered by renderOrder while content projections are pinned to zIndex 0,
    // it covers its own text and a drag-select returns "". Declaring 'none'
    // is what lets the pointer reach the text underneath.
    const sv = new ScrollView({ width: 200, height: 100 });
    expect(sv.getA11yAttributes().pointerEvents).toBe('none');
  });

  it('defaults to the bouncy spring, preserving existing behaviour', () => {
    // Guards the compatibility half of scrollPhysics: omitting the option must
    // keep the underdamped default (stiffness 180, damping 12 → ζ ≈ 0.447),
    // which overshoots its target before settling.
    const sv = new ScrollView({ width: 200, height: 100 });
    sv.add(new Box(50, 1000)); // maxScroll = 900, room to overshoot
    sv.emit('wheel', wheelEvent(240).evt);

    let overshoot = 0;
    for (let i = 0; i < 600; i++) {
      sv.update(16, i * 16);
      sv.content.update(16, i * 16);
      overshoot = Math.max(overshoot, -sv.content.y - 240);
    }
    expect(overshoot).toBeGreaterThan(10); // measured ~47px in a real browser
    expect(sv.content.y).toBeCloseTo(-240, 0); // still lands on target
  });

  it('accepts scrollPhysics and reaches the target without overshoot or reversal', () => {
    // One wheel tick under the default spring was measured overshooting 47.45px
    // (19.8%) with 5 direction reversals, settling only at 801ms and keeping
    // hasPendingAnimations() true for 181/181 sampled frames. The critically
    // damped preset removes the bounce entirely at the same travel.
    const sv = new ScrollView({
      width: 200,
      height: 100,
      scrollPhysics: DOCUMENT_SCROLL_PHYSICS,
    });
    sv.add(new Box(50, 1000));
    sv.emit('wheel', wheelEvent(240).evt);

    let overshoot = 0;
    let reversals = 0;
    let prev = sv.content.y;
    let prevDir = 0;
    for (let i = 0; i < 600; i++) {
      sv.update(16, i * 16);
      sv.content.update(16, i * 16);
      overshoot = Math.max(overshoot, -sv.content.y - 240);
      const delta = sv.content.y - prev;
      if (Math.abs(delta) > 1e-6) {
        const dir = Math.sign(delta);
        if (prevDir !== 0 && dir !== prevDir) reversals++;
        prevDir = dir;
      }
      prev = sv.content.y;
    }
    expect(overshoot).toBeLessThanOrEqual(0);
    expect(reversals).toBe(0);
    expect(sv.content.y).toBeCloseTo(-240, 0); // same destination as the default
  });

  it('exports DOCUMENT_SCROLL_PHYSICS as a critically damped config', () => {
    // ζ = damping / (2·√(stiffness·mass)); mass defaults to 1.
    const cfg = DOCUMENT_SCROLL_PHYSICS as {
      stiffness: number;
      damping: number;
    };
    const zeta = cfg.damping / (2 * Math.sqrt(cfg.stiffness));
    expect(zeta).toBeGreaterThanOrEqual(1);
    expect(zeta).toBeLessThan(1.1); // critically damped, not sluggishly over-damped
  });

  it('stays stable when targetY is set to a massive out-of-range value', () => {
    const sv = new ScrollView({ width: 200, height: 100 });
    sv.add(new Box(50, 300)); // maxScroll = 200

    // Set targetY directly to a colossal negative number
    (sv as any).targetY = -1e9;

    // Perform update tick
    sv.update(16, 0);

    // Verify targetY was clamped immediately in update, and the (now-retargeted)
    // spring drives content.y toward the clamped value, not the colossal one.
    expect((sv as any).targetY).toBe(-200);
    sv.content.update(16, 0);
    expect(sv.content.y).toBeLessThan(0);
    expect(sv.content.y).toBeGreaterThanOrEqual(-200);
  });

  it('detaches the content layer through remove(), so a leaf-first destroy cannot loop forever', () => {
    // Regression: remove() used to redirect *every* child to
    // this.content.remove(child). When the content layer itself self-detached
    // inside its own destroy() (a leaf-first tree teardown that walks children
    // before parents), content.remove(content) was a no-op, so content stayed
    // in ScrollView.children with its destroyed flag set. Entity.destroy()
    // then drains `while (children.length > 0) children.at(-1).destroy()`, and
    // the already-destroyed child returns immediately without detaching — an
    // infinite loop that froze the page main thread (vectojs-website,
    // 2026-08-13). Direct children must detach via super.remove().
    const sv = new ScrollView({ width: 200, height: 100 });
    sv.add(new Box(50, 300));

    sv.content.destroy(); // leaf-first: content destroyed before its parent
    expect(sv.children).not.toContain(sv.content); // must actually detach

    sv.destroy(); // never returned before the fix
    expect(sv.children).toHaveLength(0);
  });

  it('still routes non-content children through the content layer on remove()', () => {
    const sv = new ScrollView({ width: 200, height: 100 });
    const box = new Box(50, 300);
    sv.add(box); // nested into sv.content by add()
    sv.remove(box);
    expect(sv.content.children).toHaveLength(0);
    expect(box.parent).toBeNull();
  });

  it('drives setVisibleRange on a virtualizable content child each frame', () => {
    const sv = new ScrollView({ width: 200, height: 100 });
    const calls: Array<[number, number]> = [];
    class Virtualizable extends Box {
      constructor() {
        super(200, 5000);
      }
      setVisibleRange(scrollY: number, viewportHeight: number): void {
        calls.push([scrollY, viewportHeight]);
      }
    }
    const child = new Virtualizable();
    sv.add(child);
    sv.updateContentSize(); // content.height = 5000, so scrolling is possible

    sv.scrollTo(300); // targetY = -300
    sv.update(16, 0);

    expect(calls.length).toBeGreaterThan(0);
    const [scrollY, viewportHeight] = calls[calls.length - 1]!;
    expect(viewportHeight).toBe(100);
    // Live spring position may not equal the target immediately, but the pushed
    // range is measured from the live offset and stays non-negative.
    expect(scrollY).toBeGreaterThanOrEqual(0);
  });

  it('leaves ordinary (non-virtualizable) content untouched', () => {
    const sv = new ScrollView({ width: 200, height: 100 });
    sv.add(new Box(50, 300));
    sv.updateContentSize();
    sv.scrollTo(50);
    expect(() => sv.update(16, 0)).not.toThrow();
  });

  /** Records fillText texts so Text virtualization is observable without pixels. */
  function fillRecorder(): { r: IRenderer; texts: string[] } {
    const texts: string[] = [];
    const r = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'fillText') return (text: string) => texts.push(text);
          return () => {};
        },
      },
    ) as unknown as IRenderer;
    return { r, texts };
  }

  it('drives a tall virtualized Text through scroll positions without losing a line', () => {
    // 30 rows × lineHeight 20 = 600px of content in a 100px viewport. Each row
    // string is unique ('line0'..), so drawn fillText calls identify rows.
    const sv = new ScrollView({ width: 400, height: 100 });
    const text = new Text(Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n'));
    sv.add(text);
    sv.updateContentSize();

    const seenRows = new Set<number>();
    const windows: number[][] = [];
    // Offsets are deliberately NOT multiples of lineHeight (except the snapped
    // ends): a spring resting at ±1e-9 of an exact multiple would flip the
    // window's floor()/ceil() and make exact assertions flaky.
    const sweep: Array<() => void> = [
      () => {}, // rest at scrollTop 0
      () => sv.scrollTo(90),
      () => sv.scrollTo(215),
      () => sv.scrollTo(340),
      () => sv.scrollToBottom(), // jumpTo snaps exactly to maxScroll = 500
    ];
    for (const step of sweep) {
      step();
      settle(sv);
      const { r, texts } = fillRecorder();
      text.render(r);
      expect(texts.length).toBeGreaterThan(0);
      const rows = [...new Set(texts.map((s) => Number(s.slice(4))))].sort((a, b) => a - b);
      windows.push(rows);
      for (const n of rows) seenRows.add(n);
    }

    // Every pushed window draws one contiguous band of rows — no holes inside
    // a viewport, which would flash as blank lines during scrolling.
    for (const rows of windows) {
      expect(rows[rows.length - 1]! - rows[0]!).toBe(rows.length - 1);
    }
    // Top boundary: viewport rows 0..4 plus the two-line overscan.
    expect(windows[0]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // Bottom boundary still reaches the final content line.
    expect(windows[windows.length - 1]).toContain(29);
    // Sweeping the whole document loses nothing: consecutive windows overlap,
    // so their union covers every line exactly once over.
    expect([...seenRows].sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i));
  });
});
