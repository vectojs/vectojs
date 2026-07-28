// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Entity } from '@vectojs/core';
import { VirtualList } from '../src/VirtualList';

/**
 * A row whose height is mutable after mount, which is the whole point: a streaming
 * Markdown row grows as chunks arrive, and before this behaviour existed the list
 * read `height` once on the mount frame and never again.
 */
class GrowRow extends Entity {
  constructor(h: number) {
    super();
    this.height = h;
  }
  public override isPointInside(): boolean {
    return false;
  }
  public override render(): void {}
}

interface Msg {
  id: string;
  h: number;
}

function makeList(msgs: Msg[], opts: { keyed?: boolean; height?: number; stick?: number } = {}) {
  const rows = new Map<string, GrowRow>();
  const list = new VirtualList<Msg>({
    items: msgs,
    renderItem: (m) => {
      const row = new GrowRow(m.h);
      rows.set(m.id, row);
      return row;
    },
    estimatedRowHeight: 20,
    width: 100,
    height: opts.height ?? 100,
    overscan: 0,
    ...(opts.keyed === false ? {} : { keyForItem: (m: Msg) => m.id }),
    ...(opts.stick === undefined ? {} : { stickToBottomThreshold: opts.stick }),
  });
  // Drive one tick so the initial mount + measurement pass runs.
  list.update(16, 16);
  const priv = list as unknown as {
    _scrollY: number;
    _targetY: number;
    _heights: {
      total(): number;
      heightOf(i: number): number;
      prefix(i: number): number;
    };
    _nearBottom: boolean;
    _pool: Map<number, unknown>;
  };
  /** Run the scroll integrator to rest, as the existing ScrollIntegrators suite does. */
  const settle = (): void => {
    let t = 100;
    for (let i = 0; i < 600 && list.hasPendingAnimations(); i++) list.update(16, (t += 16));
  };
  return { list, rows, priv, settle };
}

describe('VirtualList dynamic row height', () => {
  it('re-measures a row that grows after it mounted', () => {
    // 3 rows of 20 = 60. Growing the middle one to 50 must take the total to 90 and
    // push the row below it down, without remounting anything.
    const { list, rows, priv } = makeList([
      { id: 'a', h: 20 },
      { id: 'b', h: 20 },
      { id: 'c', h: 20 },
    ]);
    expect(priv._heights.total()).toBe(60);

    rows.get('b')!.height = 50;
    list.update(16, 32);

    expect(priv._heights.total()).toBe(90);
    expect(priv._heights.heightOf(1)).toBe(50);
    // Row 'c' now starts below the grown row.
    expect(priv._heights.prefix(2)).toBe(70);
  });

  it('re-measures while the viewport is stationary, not only while scrolling', () => {
    // The measurement used to sit inside the scroll-gated branch of update(), so a
    // row growing under a still viewport — the streaming case — was never seen.
    const { list, rows, priv } = makeList([
      { id: 'a', h: 20 },
      { id: 'b', h: 20 },
    ]);
    expect(list.hasPendingAnimations()).toBe(false); // genuinely at rest

    rows.get('a')!.height = 44;
    list.update(16, 32);

    expect(priv._heights.heightOf(0)).toBe(44);
  });

  it('applies a shrink as well as a growth', () => {
    const { list, rows, priv } = makeList([
      { id: 'a', h: 40 },
      { id: 'b', h: 40 },
    ]);
    expect(priv._heights.total()).toBe(80);

    rows.get('a')!.height = 10;
    list.update(16, 32);

    expect(priv._heights.total()).toBe(50);
  });

  it('ignores a row reporting height 0 rather than treating it as measured', () => {
    // An unmeasured row reports 0. Accepting that would collapse the list to zero
    // height and take the scroll range with it.
    const { list, priv } = makeList([
      { id: 'a', h: 0 },
      { id: 'b', h: 0 },
    ]);
    expect(priv._heights.total()).toBe(40); // both still at the 20px estimate
    list.update(16, 32);
    expect(priv._heights.total()).toBe(40);
  });

  it('does not wake the scene when no row changed size', () => {
    // The no-change path runs every frame, so it must be a genuine no-op or it
    // defeats the scene's idle throttle. `Entity.scene` is a getter that walks to the
    // root, so the stub goes on the root's parent chain rather than on the instance.
    const { list } = makeList([{ id: 'a', h: 20 }]);
    let dirtied = 0;
    const fakeScene = {
      markDirty: () => {
        dirtied++;
      },
    };
    Object.defineProperty(list, 'scene', { get: () => fakeScene, configurable: true });

    list.update(16, 32);
    list.update(16, 48);
    expect(dirtied).toBe(0);

    // Sanity: the stub does register a wake when something DOES change, so a zero
    // above cannot come from the stub never being consulted.
    list.jumpToBottom();
    expect(dirtied).toBeGreaterThan(0);
  });
});

describe('VirtualList scroll anchoring', () => {
  it('keeps following the bottom when a row grows while pinned there', () => {
    // 10 rows of 20 = 200 in a 100px viewport, so max scroll is 100.
    const msgs = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, h: 20 }));
    const { list, rows, priv } = makeList(msgs);
    list.jumpToBottom();
    expect(priv._scrollY).toBe(100);

    // The last row grows by 30; a follower must end up 30 lower, still at the end.
    rows.get('m9')!.height = 50;
    list.update(16, 32);

    expect(priv._heights.total()).toBe(230);
    expect(priv._scrollY).toBe(130); // == the new max scroll
  });

  it('holds the top visible row still when a row ABOVE it grows', () => {
    // 40 rows of 20 = 800, viewport 100, so max scroll is 700 and row 3 (top 60) is
    // nowhere near the bottom. A 10-row list would put row 3 within the 48px
    // threshold and legitimately keep following instead of anchoring.
    const msgs = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, h: 20 }));
    const { list, rows, priv, settle } = makeList(msgs);
    list.scrollToIndex(3);
    settle();
    // The integrator rests within its own 0.05 epsilon of the target, not exactly on
    // it, so compare with a tolerance here and assert the exact geometry below.
    expect(priv._scrollY).toBeCloseTo(60, 1);
    expect(priv._nearBottom).toBe(false);

    // Grow row 2, which is MOUNTED (the pool holds 2..7 here) and sits above the
    // anchor. Row 0 would be the more obvious choice and is wrong: with overscan 0 it
    // is not mounted at this scroll position, so its height is never polled and
    // growing its detached entity correctly changes nothing — an off-screen row's
    // height is only learned when it mounts.
    rows.get('m2')!.height = 50;
    list.update(16, 48);

    // Row 3's top moves 60 -> 90, and the viewport follows so the same row stays
    // under the top edge.
    expect(priv._heights.prefix(3)).toBe(90);
    expect(priv._scrollY).toBe(90);
  });

  it('preserves an offset into the middle of the anchored row', () => {
    const msgs = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, h: 20 }));
    const { list, rows, priv } = makeList(msgs);
    // 65 is 5px into row 3, and far from the bottom of an 800px list.
    priv._targetY = 65;
    priv._scrollY = 65;
    (list as unknown as { _latchBottom(): void })._latchBottom();
    list.update(16, 32);

    rows.get('m2')!.height = 50; // +30 above the anchor, and mounted
    list.update(16, 48);

    expect(priv._scrollY).toBe(95); // row 3 top (90) + the 5px offset
  });

  it('falls back to a clamp when the anchored row disappears', () => {
    const msgs = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, h: 20 }));
    const { list, priv, settle } = makeList(msgs);
    list.scrollToIndex(5);
    settle();
    expect(priv._nearBottom).toBe(false);

    // Drop the anchored row and everything after it.
    list.setItems(msgs.slice(0, 3));

    // 3 rows, viewport 100: content is shorter than the viewport, so the only valid
    // scroll position is 0 regardless of what the anchor asked for.
    expect(priv._targetY).toBe(0);
  });

  it('latches following at the last scroll rather than measuring it mid-resize', () => {
    // During streaming several rows resize before the reconcile runs, so the live
    // distance from the bottom is transiently large. Reading it then would
    // disengage following mid-stream; the latch is what prevents that.
    const msgs = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, h: 20 }));
    const { list, rows, priv } = makeList(msgs);
    list.jumpToBottom();

    // Three separate growths in three frames, as chunks would arrive.
    for (const id of ['m7', 'm8', 'm9']) {
      rows.get(id)!.height = 60;
      list.update(16, 32);
    }

    // Still exactly at the bottom of the now much taller content.
    expect(priv._heights.total()).toBe(20 * 7 + 60 * 3);
    expect(priv._scrollY).toBe(priv._heights.total() - 100);
  });

  it('stops following once the user scrolls beyond the threshold', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, h: 20 }));
    const { list, rows, priv } = makeList(msgs, { stick: 48 });
    list.jumpToBottom();
    expect(priv._nearBottom).toBe(true);

    // Scroll up 60px, past the 48px threshold.
    priv._targetY = 40;
    (list as unknown as { _latchBottom(): void })._latchBottom();
    expect(priv._nearBottom).toBe(false);

    const before = priv._scrollY;
    rows.get('m9')!.height = 80; // content grows below the viewport
    list.update(16, 32);

    // The viewport must NOT jump to the new bottom.
    expect(priv._scrollY).toBeLessThan(before + 10);
  });
});

describe('VirtualList anchor edge cases', () => {
  it('re-pins flush to the bottom after several rows grow in one frame', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, h: 20 }));
    const { list, rows, priv } = makeList(msgs);
    list.jumpToBottom();

    rows.get('m9')!.height = 40;
    rows.get('m8')!.height = 40;
    list.update(16, 32);

    expect(priv._scrollY).toBe(priv._heights.total() - 100);
  });

  it('keeps the anchored row visible when that row itself shrinks below the offset', () => {
    // The offset was captured INSIDE the anchored row. If the row then shrinks
    // shorter than the offset, restoring it unclamped scrolls past the row entirely,
    // so the row the anchor exists to keep visible is the one that leaves the screen.
    const msgs = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, h: 60 }));
    const { list, rows, priv, settle } = makeList(msgs);
    // Sit 50px into row 3 (row 3 spans 180..240).
    priv._targetY = 230;
    priv._scrollY = 230;
    (list as unknown as { _latchBottom(): void })._latchBottom();
    settle();
    expect(priv._nearBottom).toBe(false);

    // Row 3 shrinks to 10px, far shorter than the 50px offset into it.
    rows.get('m3')!.height = 10;
    list.update(16, 64);

    // The clamp keeps the viewport within the row: its top is still 180, and the
    // offset is capped at the row's new height rather than the captured 50.
    expect(priv._heights.prefix(3)).toBe(180);
    expect(priv._scrollY).toBe(190); // 180 + min(50, 10)
  });

  it('settles rather than animating forever while content grows under a follower', () => {
    // The restore moves `_targetY`; if `_scrollY` were left behind, every resize
    // would spawn a fresh scroll animation, so a steadily growing transcript would
    // never let the scene idle. Assert across MANY growths, not one.
    const msgs = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, h: 20 }));
    const { list, rows, priv } = makeList(msgs);
    list.jumpToBottom();

    let t = 100;
    for (let n = 0; n < 12; n++) {
      rows.get('m9')!.height = 20 + n * 10;
      list.update(16, (t += 16));
      // Never mid-flight: the position tracks the target on the same frame.
      expect(list.hasPendingAnimations()).toBe(false);
      expect(priv._scrollY).toBe(priv._targetY);
    }
    expect(priv._scrollY).toBe(priv._heights.total() - 100);
  });
});

describe('VirtualList keyed identity', () => {
  it('carries measured heights across setItems when keyed', () => {
    const msgs = [
      { id: 'a', h: 40 },
      { id: 'b', h: 40 },
    ];
    const { list, priv } = makeList(msgs);
    expect(priv._heights.total()).toBe(80);

    // Append. The two existing rows keep their cached height rather than dropping
    // back to the estimate, which is what an index-keyed cache would have done.
    list.setItems([...msgs, { id: 'c', h: 40 }]);
    expect(priv._heights.heightOf(0)).toBe(40);
    expect(priv._heights.heightOf(1)).toBe(40);
    // The appended row is inside the viewport, so `setItems`' own reconcile mounts
    // and measures it in the same pass — 120, not 100 with an estimate.
    expect(priv._heights.total()).toBe(120);
  });

  it('survives a prepend, which index identity cannot', () => {
    // A prepend shifts every index by one. With index identity every cached height
    // would now describe the wrong row.
    const msgs = [
      { id: 'a', h: 30 },
      { id: 'b', h: 50 },
    ];
    const { list, priv } = makeList(msgs);
    expect(priv._heights.heightOf(0)).toBe(30);
    expect(priv._heights.heightOf(1)).toBe(50);

    list.setItems([{ id: 'z', h: 70 }, ...msgs]);

    expect(priv._heights.heightOf(1)).toBe(30); // 'a', shifted but intact
    expect(priv._heights.heightOf(2)).toBe(50); // 'b'
    expect(priv._heights.heightOf(0)).toBe(70); // 'z', mounted and measured
  });

  it('still resets to the top on setItems when NOT keyed', () => {
    // The old contract, preserved: an unkeyed list has no way to tell an append
    // from a replacement, so a replacement is the safe reading.
    const msgs = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, h: 20 }));
    const { list, priv } = makeList(msgs, { keyed: false });
    list.scrollToIndex(5);
    list.update(16, 32);
    expect(priv._scrollY).toBeGreaterThan(0);

    list.setItems(msgs);
    expect(priv._scrollY).toBe(0);
    expect(priv._targetY).toBe(0);
  });
});

describe('VirtualList keyed height cache and follow disengage', () => {
  it('remembers the height of a row that has since left the mounted window', () => {
    // This is the case the keyed cache exists for, and the only one that isolates it:
    // a row still in the pool gets re-measured from its live entity during
    // `setItems`' own reconcile, so the cache is never consulted and a broken cache
    // still looks correct. Scroll the row out of the pool first, and the cache is the
    // ONLY remaining record of its height.
    const msgs = Array.from({ length: 60 }, (_, i) => ({ id: `k${i}`, h: 20 }));
    const { list, rows, priv } = makeList(msgs);

    rows.get('k0')!.height = 100; // grow row 0 while it is mounted
    list.update(16, 32);
    expect(priv._heights.heightOf(0)).toBe(100);

    list.jumpToBottom(); // row 0 leaves the pool
    expect(priv._pool.has(0)).toBe(false);

    list.setItems([...msgs, { id: 'new', h: 20 }]);
    // 100 can only have come from the keyed cache; 20 would mean it was lost.
    expect(priv._heights.heightOf(0)).toBe(100);
  });

  it('stops following when the user scrolls up with the wheel', () => {
    // The wheel handler has to re-latch, or a user who scrolls up mid-stream is
    // dragged back down by the next row that grows.
    const msgs = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, h: 20 }));
    const { list, rows, priv } = makeList(msgs);
    list.jumpToBottom();
    expect(priv._nearBottom).toBe(true);

    // Through the bound handler rather than the private latch. `emit`, not
    // `dispatchEvent`: the latter runs the capture/bubble walk, which needs a scene, so
    // on a detached list it reaches no listener and this would pass vacuously.
    list.emit('wheel', {
      deltaY: -400,
      ctrlKey: false,
      preventDefault: () => {},
    } as unknown as WheelEvent);
    expect(priv._targetY).toBe(300); // 700 - 400, proving the handler ran
    expect(priv._nearBottom).toBe(false);

    const before = priv._targetY;
    rows.get('m39')!.height = 200; // content grows far below the viewport
    list.update(16, 32);

    expect(priv._targetY).toBe(before); // not yanked to the new bottom
  });
});

describe('VirtualList jumpToBottom', () => {
  it('arrives instantly, unlike scrollToBottom', () => {
    const msgs = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, h: 20 }));
    const { list, priv } = makeList(msgs);

    list.scrollToBottom();
    expect(priv._scrollY).toBe(0); // target moved, position has not
    expect(list.hasPendingAnimations()).toBe(true);

    list.jumpToBottom();
    expect(priv._scrollY).toBe(300); // 20*20 - 100
    expect(list.hasPendingAnimations()).toBe(false); // nothing left to animate
  });

  it('leaves no pending animation when content grows while followed', () => {
    // A resize that moved only the target would leave the integrator running, so a
    // steadily growing transcript would animate forever and never let the scene idle.
    const msgs = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, h: 20 }));
    const { list, rows } = makeList(msgs);
    list.jumpToBottom();

    rows.get('m9')!.height = 60;
    list.update(16, 32);

    expect(list.hasPendingAnimations()).toBe(false);
  });
});
