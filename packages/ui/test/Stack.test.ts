// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Entity } from '@vectojs/core';
import { Stack } from '../src/Stack';

/** A minimal concrete entity with a known size for layout testing. */
class Box extends Entity {
  constructor(w: number, h: number) {
    super();
    this.width = w;
    this.height = h;
  }
  isPointInside() {
    return false;
  }
  render() {}
}

describe('Stack fast-append path', () => {
  it('positions many sequential vertical start-aligned children the same as a full layout would', () => {
    const fast = new Stack({ direction: 'vertical', gap: 4 });
    const boxes = [
      new Box(20, 10),
      new Box(35, 10),
      new Box(15, 25),
      new Box(50, 5),
      new Box(30, 30),
    ];
    for (const b of boxes) fast.add(b);

    const reference = new Stack({ direction: 'vertical', gap: 4 });
    for (const b of [
      new Box(20, 10),
      new Box(35, 10),
      new Box(15, 25),
      new Box(50, 5),
      new Box(30, 30),
    ]) {
      reference.add(b);
    }
    reference.layout();

    for (let i = 0; i < boxes.length; i++) {
      expect(fast.children[i].x).toBe(reference.children[i].x);
      expect(fast.children[i].y).toBe(reference.children[i].y);
    }
    expect(fast.width).toBe(reference.width);
    expect(fast.height).toBe(reference.height);
    // width tracks the widest child seen so far (cross-axis growth)
    expect(fast.width).toBe(50);
    expect(fast.height).toBe(10 + 4 + 10 + 4 + 25 + 4 + 5 + 4 + 30);
  });

  it('positions many sequential horizontal start-aligned children the same as a full layout would', () => {
    const fast = new Stack({ direction: 'horizontal', gap: 3 });
    for (const [w, h] of [
      [10, 20],
      [10, 45],
      [10, 5],
      [10, 30],
    ]) {
      fast.add(new Box(w, h));
    }
    expect(fast.height).toBe(45); // max child height seen
    expect(fast.width).toBe(10 * 4 + 3 * 3);
    expect(fast.children[3].x).toBe(10 + 3 + 10 + 3 + 10 + 3);
  });

  it('still falls back to full layout when wrap is true', () => {
    const stack = new Stack({
      direction: 'horizontal',
      wrap: true,
      maxWidth: 100,
      gap: 10,
    });
    stack.add(new Box(50, 20));
    stack.add(new Box(50, 20));
    stack.add(new Box(50, 20));
    // Same wrapping result as the pre-existing Flow.test.ts wrap coverage.
    expect(stack.children[1].y).toBe(20 + 10);
    expect(stack.children[2].y).toBe((20 + 10) * 2);
  });

  it('still falls back to full layout for non-start align', () => {
    const stack = new Stack({
      direction: 'horizontal',
      align: 'center',
      gap: 0,
    });
    stack.add(new Box(50, 20));
    stack.add(new Box(50, 40));
    expect(stack.children[0].y).toBe(10); // (40 - 20) / 2
    expect(stack.children[1].y).toBe(0);
  });

  it('resyncs correctly via full layout after a remove-then-add swap', () => {
    const stack = new Stack({ direction: 'vertical', gap: 5 });
    const a = new Box(10, 10);
    const b = new Box(10, 10);
    const c = new Box(10, 10);
    stack.add(a);
    stack.add(b);
    stack.add(c);
    // Before swap: a@0, b@15, c@30, height = 10+5+10+5+10 = 40, width = 10
    expect(stack.height).toBe(40);

    // Simulate the reconcile-swap pattern used by Markdown/MathMarkdown: remove
    // the stale last child, then immediately add its replacement, where the
    // replacement is cross-axis larger — this must NOT use the stale
    // (still-including-c) width/height as the base offset for the new child.
    stack.remove(c);
    const replacement = new Box(40, 60);
    stack.add(replacement);

    expect(replacement.x).toBe(0);
    expect(replacement.y).toBe(10 + 5 + 10 + 5); // full relayout of [a, b, replacement]
    expect(stack.width).toBe(40); // widened to the replacement's width
    expect(stack.height).toBe(10 + 5 + 10 + 5 + 60);
  });

  it('resyncs correctly after removing a non-last child then adding', () => {
    const stack = new Stack({ direction: 'horizontal', gap: 2 });
    const a = new Box(10, 10);
    const b = new Box(10, 10);
    const c = new Box(10, 10);
    stack.add(a);
    stack.add(b);
    stack.add(c);

    stack.remove(b);
    const d = new Box(5, 5);
    stack.add(d);

    // Remaining children after remove: [a, c]; add() appends d after them via
    // a full layout() resync, so d must sit after c, not at a stale offset.
    // Uses fresh Box instances (not a/c themselves) since Entity.add() would
    // reparent — and thus unlink from `stack` — any entity reused across trees.
    const layout = new Stack({ direction: 'horizontal', gap: 2 });
    layout.add(new Box(10, 10));
    layout.add(new Box(10, 10));
    layout.add(new Box(5, 5));
    layout.layout();

    expect(stack.children.map((ch) => ch.x)).toEqual(layout.children.map((ch) => ch.x));
    expect(stack.width).toBe(layout.width);
    expect(stack.height).toBe(layout.height);
  });

  it('places the very first child at the origin regardless of direction', () => {
    const v = new Stack({ direction: 'vertical' });
    v.add(new Box(12, 34));
    expect(v.children[0].x).toBe(0);
    expect(v.children[0].y).toBe(0);
    expect(v.width).toBe(12);
    expect(v.height).toBe(34);

    const h = new Stack({ direction: 'horizontal' });
    h.add(new Box(12, 34));
    expect(h.children[0].x).toBe(0);
    expect(h.children[0].y).toBe(0);
    expect(h.width).toBe(12);
    expect(h.height).toBe(34);
  });
});

describe('Stack offscreen-child culling', () => {
  it('returns a bounded half-open range without removing vertical children', () => {
    const stack = new Stack({
      direction: 'vertical',
      gap: 5,
      cullOffscreenChildren: true,
    });
    for (let i = 0; i < 100; i++) stack.add(new Box(100, 20));

    const range = stack.getRenderChildRange({ x: 0, y: 1000, width: 100, height: 100 });

    expect(range).not.toBeNull();
    expect(range!.start).toBeGreaterThan(35);
    expect(range!.end - range!.start).toBeLessThan(10);
    expect(stack.children).toHaveLength(100);
  });

  it('declines culling when layout can wrap across the main axis', () => {
    const stack = new Stack({
      direction: 'horizontal',
      wrap: true,
      cullOffscreenChildren: true,
    });
    stack.add(new Box(20, 20));

    expect(stack.getRenderChildRange({ x: 0, y: 0, width: 100, height: 100 })).toBeNull();
  });
});

describe('Stack.resizeLastChild', () => {
  it('grows the container along the main axis without moving earlier siblings (vertical)', () => {
    const stack = new Stack({ direction: 'vertical', gap: 5 });
    const a = new Box(20, 10);
    const b = new Box(20, 10);
    stack.add(a);
    stack.add(b);
    expect(b.y).toBe(15); // a(10) + gap(5)
    expect(stack.height).toBe(25);

    // Simulate a streaming paragraph growing taller in place (more text
    // wrapped to another line) with no add()/remove() call at all.
    b.height = 40;
    stack.resizeLastChild(b);

    expect(a.x).toBe(0);
    expect(a.y).toBe(0); // untouched
    expect(b.y).toBe(15); // untouched — only its own size changed
    expect(stack.height).toBe(15 + 40);
    expect(stack.width).toBe(20);
  });

  it('grows the container along the main axis without moving earlier siblings (horizontal)', () => {
    const stack = new Stack({ direction: 'horizontal', gap: 4 });
    const a = new Box(10, 20);
    const b = new Box(10, 20);
    stack.add(a);
    stack.add(b);
    expect(b.x).toBe(14);

    b.width = 50;
    stack.resizeLastChild(b);

    expect(a.y).toBe(0);
    expect(b.x).toBe(14); // untouched
    expect(stack.width).toBe(14 + 50);
    expect(stack.height).toBe(20);
  });

  it('grows the cross-axis size when the resized child becomes the widest', () => {
    const stack = new Stack({ direction: 'vertical', gap: 0 });
    const a = new Box(20, 10);
    const b = new Box(20, 10);
    stack.add(a);
    stack.add(b);
    expect(stack.width).toBe(20);

    b.width = 80;
    stack.resizeLastChild(b);

    expect(stack.width).toBe(80);
  });

  it('falls back to a full layout when the given entity is not the last child', () => {
    const stack = new Stack({ direction: 'vertical', gap: 5 });
    const a = new Box(20, 10);
    const b = new Box(20, 10);
    stack.add(a);
    stack.add(b);

    a.height = 999; // not the last child — must not take the O(1) shortcut
    stack.resizeLastChild(a);

    // A full layout() correctly repositions b below a's new height.
    expect(b.y).toBe(999 + 5);
    expect(stack.height).toBe(999 + 5 + 10);
  });

  it('falls back to a full layout for wrap or non-start align', () => {
    const wrapStack = new Stack({
      direction: 'horizontal',
      wrap: true,
      maxWidth: 100,
      gap: 0,
    });
    const a = new Box(50, 20);
    const b = new Box(50, 20);
    wrapStack.add(a);
    wrapStack.add(b);
    b.width = 90;
    expect(() => wrapStack.resizeLastChild(b)).not.toThrow();

    const centerStack = new Stack({
      direction: 'vertical',
      align: 'center',
      gap: 0,
    });
    const c = new Box(20, 10);
    const d = new Box(20, 10);
    centerStack.add(c);
    centerStack.add(d);
    d.width = 60;
    centerStack.resizeLastChild(d);
    expect(d.x).toBe(0); // recomputed via full layout's center alignment
  });

  it('resyncs correctly if called right after a remove()', () => {
    const stack = new Stack({ direction: 'vertical', gap: 5 });
    const a = new Box(20, 10);
    const b = new Box(20, 10);
    const c = new Box(20, 10);
    stack.add(a);
    stack.add(b);
    stack.add(c);
    stack.remove(c);

    b.height = 40;
    stack.resizeLastChild(b);

    // fastAppendDirty forces a full layout() resync here, which correctly
    // reflects the post-remove, post-resize state (only a + resized b).
    expect(stack.height).toBe(10 + 5 + 40);
  });
});

describe('Stack wrap fast-append equivalence (O(N^2) -> O(N))', () => {
  // Deterministic size profile so the test is reproducible.
  function boxes(): Array<[number, number]> {
    let s = 0x9e37;
    const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0x100000000);
    return Array.from({ length: 40 }, () => [
      8 + Math.floor(rand() * 40),
      6 + Math.floor(rand() * 20),
    ]);
  }

  for (const direction of ['horizontal', 'vertical'] as const) {
    it(`${direction}: incremental wrap appends match a single full layout`, () => {
      const limit = 120;
      const opts = {
        direction,
        gap: 5,
        wrap: true,
        maxWidth: direction === 'horizontal' ? limit : Infinity,
        maxHeight: direction === 'vertical' ? limit : Infinity,
      };
      const sizes = boxes();

      // FAST: one add() per child (each takes the O(1) wrap fast path).
      const fast = new Stack(opts);
      for (const [w, h] of sizes) fast.add(new Box(w, h));

      // REFERENCE: same children, but force a single full layout() at the end.
      const ref = new Stack(opts);
      for (const [w, h] of sizes) (ref as any).children.push(new Box(w, h));
      // give each child its scene-graph parent link the way add() would
      for (const c of (ref as any).children) c.parent = ref;
      ref.layout();

      // Identical container size…
      expect(fast.width).toBeCloseTo(ref.width, 6);
      expect(fast.height).toBeCloseTo(ref.height, 6);
      // …and identical per-child positions.
      for (let i = 0; i < sizes.length; i++) {
        expect(fast.children[i].x).toBeCloseTo(ref.children[i].x, 6);
        expect(fast.children[i].y).toBeCloseTo(ref.children[i].y, 6);
      }
    });
  }

  it('a full layout() after fast appends keeps subsequent fast appends correct', () => {
    const opts = {
      direction: 'horizontal' as const,
      gap: 5,
      wrap: true,
      maxWidth: 100,
    };
    const fast = new Stack(opts);
    for (const [w, h] of boxes().slice(0, 10)) fast.add(new Box(w, h));
    fast.layout(); // force a full re-layout mid-stream (refreshes wrap state)
    for (const [w, h] of boxes().slice(10, 20)) fast.add(new Box(w, h));

    const ref = new Stack(opts);
    for (const [w, h] of boxes().slice(0, 20)) (ref as any).children.push(new Box(w, h));
    for (const c of (ref as any).children) c.parent = ref;
    ref.layout();

    expect(fast.width).toBeCloseTo(ref.width, 6);
    expect(fast.height).toBeCloseTo(ref.height, 6);
    for (let i = 0; i < 20; i++) {
      expect(fast.children[i].x).toBeCloseTo(ref.children[i].x, 6);
      expect(fast.children[i].y).toBeCloseTo(ref.children[i].y, 6);
    }
  });
});

describe('Stack fillTarget', () => {
  it('stretches the last vertical child by the remaining extent after fixed siblings and gaps', () => {
    const stack = new Stack({ direction: 'vertical', gap: 5, fillTarget: 100 });
    const a = new Box(20, 10);
    const b = new Box(20, 15);
    const c = new Box(20, 10);
    stack.add(a);
    stack.add(b);
    stack.add(c);

    // remaining = 100 - (10 + 15) - (2 gaps * 5) = 65 -> c stretches to 65.
    expect(c.height).toBe(65);
    expect(a.y).toBe(0);
    expect(b.y).toBe(15);
    expect(c.y).toBe(35); // 10 + 5 + 15 + 5
    // children + gaps total exactly fillTarget…
    expect(c.y + c.height).toBe(100);
    // …the container reports exactly fillTarget along the main axis…
    expect(stack.height).toBe(100);
    // …and the cross axis is unchanged (widest child).
    expect(stack.width).toBe(20);
  });

  it('works along the horizontal axis too', () => {
    const stack = new Stack({ direction: 'horizontal', gap: 4, fillTarget: 120 });
    const a = new Box(30, 10);
    const b = new Box(40, 20);
    const c = new Box(10, 5);
    stack.add(a);
    stack.add(b);
    stack.add(c);

    // remaining = 120 - (30 + 40) - (2 gaps * 4) = 42 -> c widens to 42.
    expect(c.width).toBe(42);
    expect(a.x).toBe(0);
    expect(b.x).toBe(34);
    expect(c.x).toBe(78); // 30 + 4 + 40 + 4
    expect(stack.width).toBe(120);
    expect(stack.height).toBe(20); // cross axis unchanged
  });

  it('fills the entire target when there is only one child', () => {
    const stack = new Stack({ direction: 'vertical', gap: 7, fillTarget: 80 });
    const only = new Box(10, 10);
    stack.add(only);

    expect(only.height).toBe(80);
    expect(only.y).toBe(0);
    expect(stack.height).toBe(80);
  });

  it('floors the last child at its content size when space is insufficient', () => {
    const stack = new Stack({ direction: 'vertical', gap: 5, fillTarget: 30 });
    const a = new Box(20, 10);
    const b = new Box(20, 15);
    const c = new Box(20, 10);
    stack.add(a);
    stack.add(b);
    stack.add(c);

    // remaining = 30 - 25 - 10 = -5 < c's content height of 10: c keeps its
    // content size and the laid-out children overflow the container, which
    // still reports exactly fillTarget (overflow semantics).
    expect(c.height).toBe(10);
    expect(c.y).toBe(35);
    expect(stack.height).toBe(30);
  });

  it('keeps repeated layouts idempotent instead of compounding the stretch', () => {
    const stack = new Stack({ direction: 'vertical', gap: 5, fillTarget: 100 });
    stack.add(new Box(20, 10));
    const b = new Box(20, 10);
    stack.add(b);
    expect(b.height).toBe(85);

    stack.layout();
    stack.layout();
    expect(b.height).toBe(85); // not 85 stretched again
    expect(stack.height).toBe(100);
  });

  it('lets a shrinking fillTarget take effect on the next layout', () => {
    const stack = new Stack({ direction: 'vertical', gap: 5, fillTarget: 100 });
    stack.add(new Box(20, 10));
    const b = new Box(20, 10);
    stack.add(b);
    expect(b.height).toBe(85);

    stack.fillTarget = 50;
    stack.layout();
    // remaining = 50 - 10 - 5 = 35.
    expect(b.height).toBe(35);
    expect(stack.height).toBe(50);
  });

  it('restores the previously stretched child when a new last child is added', () => {
    const stack = new Stack({ direction: 'vertical', gap: 5, fillTarget: 100 });
    const a = new Box(20, 10);
    const b = new Box(20, 10);
    stack.add(a);
    stack.add(b);
    expect(b.height).toBe(85); // was stretched

    const c = new Box(20, 10);
    stack.add(c);
    // b is back to its content size and the stretch moved onto c.
    expect(b.height).toBe(10);
    expect(b.y).toBe(15);
    expect(c.height).toBe(70); // 100 - (10 + 10) - (2 gaps * 5)
    expect(c.y).toBe(30);
    expect(stack.height).toBe(100);
  });

  it('produces via add() exactly what a direct full layout() produces (fast paths disabled)', () => {
    const opts = { direction: 'vertical' as const, gap: 5, fillTarget: 90 };
    const sizes: Array<[number, number]> = [
      [20, 10],
      [35, 25],
      [50, 8],
      [30, 12],
    ];

    const fast = new Stack(opts);
    for (const [w, h] of sizes) fast.add(new Box(w, h));

    const ref = new Stack(opts);
    for (const [w, h] of sizes) (ref as any).children.push(new Box(w, h));
    for (const c of (ref as any).children) c.parent = ref;
    ref.layout();

    expect(fast.width).toBe(ref.width);
    expect(fast.height).toBe(ref.height);
    for (let i = 0; i < sizes.length; i++) {
      expect(fast.children[i].x).toBe(ref.children[i].x);
      expect(fast.children[i].y).toBe(ref.children[i].y);
      expect(fast.children[i].width).toBe(ref.children[i].width);
      expect(fast.children[i].height).toBe(ref.children[i].height);
    }
    // Last child fills: 90 - (10 + 25 + 8) - (3 gaps * 5) = 32.
    expect(fast.children[3].height).toBe(32);
  });

  it('routes resizeLastChild through a full layout while filling', () => {
    const stack = new Stack({ direction: 'vertical', gap: 5, fillTarget: 100 });
    stack.add(new Box(20, 10));
    const b = new Box(20, 10);
    stack.add(b);
    expect(b.height).toBe(85);

    // Externally shrink the last child's content, then notify: the O(1)
    // arithmetic assumes content-sized children, so this must fall back to a
    // full layout and recompute the stretch from the new content size.
    b.height = 4;
    stack.resizeLastChild(b);
    expect(b.height).toBe(85); // 100 - 10 - 5
    expect(stack.height).toBe(100);
  });

  it('leaves an empty stack content-sized (zero) even with fillTarget set', () => {
    const stack = new Stack({ fillTarget: 200 });
    stack.layout();
    expect(stack.width).toBe(0);
    expect(stack.height).toBe(0);
  });

  it('is byte-identical to legacy behavior when unset', () => {
    const legacy = new Stack({ direction: 'horizontal', gap: 3 });
    const unset = new Stack({ direction: 'horizontal', gap: 3, fillTarget: undefined });
    for (const [w, h] of [
      [10, 20],
      [10, 45],
      [10, 5],
    ]) {
      legacy.add(new Box(w, h));
      unset.add(new Box(w, h));
    }

    expect(unset.width).toBe(legacy.width);
    expect(unset.height).toBe(legacy.height);
    // Legacy content-sized totals, untouched by any fill logic.
    expect(legacy.width).toBe(10 * 3 + 3 * 2);
    expect(legacy.height).toBe(45);
    for (let i = 0; i < 3; i++) {
      expect(unset.children[i].x).toBe(legacy.children[i].x);
      expect(unset.children[i].y).toBe(legacy.children[i].y);
      expect(unset.children[i].width).toBe(legacy.children[i].width);
      expect(unset.children[i].height).toBe(legacy.children[i].height);
    }
  });

  it('is ignored entirely when wrap is true', () => {
    const opts = {
      direction: 'horizontal' as const,
      wrap: true,
      maxWidth: 100,
      gap: 10,
    };
    const withFill = new Stack({ ...opts, fillTarget: 1000 });
    const without = new Stack(opts);
    for (const [w, h] of [
      [50, 20],
      [50, 20],
      [50, 20],
    ]) {
      withFill.add(new Box(w, h));
      without.add(new Box(w, h));
    }

    expect(withFill.width).toBe(without.width);
    expect(withFill.height).toBe(without.height);
    expect(withFill.children[2].width).toBe(50); // never stretched
    for (let i = 0; i < 3; i++) {
      expect(withFill.children[i].x).toBe(without.children[i].x);
      expect(withFill.children[i].y).toBe(without.children[i].y);
    }
  });

  it('keeps culling ranges monotonic and sane while the last child is stretched', () => {
    const stack = new Stack({
      direction: 'vertical',
      gap: 0,
      fillTarget: 500,
      cullOffscreenChildren: true,
    });
    for (let i = 0; i < 20; i++) stack.add(new Box(100, 20));

    // 19 fixed children of 20 + stretched last child of 120.
    expect(stack.children[19].height).toBe(120);
    expect(stack.height).toBe(500);
    // Positions remain strictly descending-free / monotonically increasing,
    // which the binary search in getRenderChildRange relies on.
    for (let i = 1; i < 20; i++) {
      expect(stack.children[i].y).toBeGreaterThan(stack.children[i - 1].y);
    }

    const range = stack.getRenderChildRange({ x: 0, y: 300, width: 100, height: 100 });
    expect(range).not.toBeNull();
    expect(range!.start).toBe(14); // first child whose band reaches y >= 300
    expect(range!.end).toBe(20);
    expect(range!.end).toBeLessThanOrEqual(20);
    expect(stack.children).toHaveLength(20);
  });
});
