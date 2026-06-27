// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Entity } from '@vecto-ui/core';
import { Stack } from '../src/Stack';
import { Flow } from '../src/Flow';

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

describe('Stack wrap', () => {
  it('wraps horizontal children when exceeding maxWidth', () => {
    const stack = new Stack({ direction: 'horizontal', wrap: true, maxWidth: 100, gap: 10 });
    stack.add(new Box(50, 20));
    stack.add(new Box(50, 20));
    stack.add(new Box(50, 20));

    // First line: 50 + 10 + 50 = 110 > 100, so second child goes to next line?
    // Actually: child1=50, then child2 would be 50+10+50=110 > 100, so child2 wraps.
    // Line 1: [child1] (50px), Line 2: [child2] (50px), Line 3: [child3] (50px)
    // Wait, 50 <= 100, then 50+10+50 = 110 > 100, wrap.
    // Line 1: [50], Line 2: [50, gap, 50] = 110 > 100? No, line 2 starts fresh: [50], then [50+10+50]=110 > 100, wrap again.
    // Line 1: [child1], Line 2: [child2], Line 3: [child3]
    const c = stack.children;
    // Each line has only 1 child (50px fits, but 50+10+50 doesn't)
    expect(c[0].x).toBe(0);
    expect(c[0].y).toBe(0);
    expect(c[1].x).toBe(0);
    expect(c[1].y).toBe(20 + 10); // next line offset = height of first line + gap
    expect(c[2].x).toBe(0);
    expect(c[2].y).toBe((20 + 10) * 2);
  });

  it('fits multiple children on one line when they fit', () => {
    const stack = new Stack({ direction: 'horizontal', wrap: true, maxWidth: 200, gap: 10 });
    stack.add(new Box(50, 20));
    stack.add(new Box(50, 20));
    stack.add(new Box(50, 20));

    // 50 + 10 + 50 = 110 <= 200, 110 + 10 + 50 = 170 <= 200 → all on one line
    const c = stack.children;
    expect(c[0].x).toBe(0);
    expect(c[1].x).toBe(60); // 50 + 10
    expect(c[2].x).toBe(120); // 50 + 10 + 50 + 10
    expect(c[0].y).toBe(0);
    expect(c[1].y).toBe(0);
    expect(c[2].y).toBe(0);
  });

  it('computes correct container size with wrapping', () => {
    const stack = new Stack({ direction: 'horizontal', wrap: true, maxWidth: 100, gap: 5 });
    stack.add(new Box(40, 20));
    stack.add(new Box(40, 20));
    stack.add(new Box(40, 20));

    // 40 + 5 + 40 = 85 <= 100, 85 + 5 + 40 = 130 > 100
    // Line 1: [40, 40] → main = 85, Line 2: [40] → main = 40
    // Container width = max(85, 40) = 85
    // Container height = 20 + 5 + 20 = 45
    expect(stack.width).toBe(85);
    expect(stack.height).toBe(45);
  });

  it('single-line layout is unchanged when wrap is false', () => {
    const stack = new Stack({ direction: 'horizontal', gap: 10 });
    stack.add(new Box(50, 20));
    stack.add(new Box(50, 20));

    expect(stack.children[0].x).toBe(0);
    expect(stack.children[1].x).toBe(60);
    expect(stack.width).toBe(110);
    expect(stack.height).toBe(20);
  });
});

describe('Flow', () => {
  it('defaults to horizontal direction with wrap enabled', () => {
    const flow = new Flow();
    expect(flow.direction).toBe('horizontal');
    expect(flow.wrap).toBe(true);
  });

  it('wraps children into multiple lines', () => {
    const flow = new Flow({ gap: 10, maxWidth: 100 });
    flow.add(new Box(40, 20));
    flow.add(new Box(40, 20));
    flow.add(new Box(40, 20));

    // Same as Stack wrap test above
    // Line 1: [40, 40] (85px), Line 2: [40] (40px)
    expect(flow.children[2].y).toBeGreaterThan(0); // wrapped to next line
    expect(flow.children[0].y).toBe(0);
    expect(flow.children[1].y).toBe(0);
  });

  it('accepts align option', () => {
    const flow = new Flow({ gap: 0, maxWidth: 200, align: 'center' });
    flow.add(new Box(50, 20));
    flow.add(new Box(50, 40));

    // Cross-axis (y): line cross = 40, so child1 (height 20) centered at (40-20)/2 = 10
    expect(flow.children[0].y).toBe(10);
    expect(flow.children[1].y).toBe(0);
  });
});
