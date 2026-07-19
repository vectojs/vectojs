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
    const stack = new Stack({ direction: 'horizontal', wrap: true, maxWidth: 100, gap: 10 });
    stack.add(new Box(50, 20));
    stack.add(new Box(50, 20));
    stack.add(new Box(50, 20));
    // Same wrapping result as the pre-existing Flow.test.ts wrap coverage.
    expect(stack.children[1].y).toBe(20 + 10);
    expect(stack.children[2].y).toBe((20 + 10) * 2);
  });

  it('still falls back to full layout for non-start align', () => {
    const stack = new Stack({ direction: 'horizontal', align: 'center', gap: 0 });
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
