// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Entity } from '@vectojs/core';
import { ScrollView } from '../src/index';

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

/** A pointer-event stand-in carrying a clientY. */
function pointer(clientY: number): { clientY: number; preventDefault: () => void } {
  return { clientY, preventDefault: () => {} };
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
});
