// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { Entity } from '@vectojs/core';
import { VirtualList } from '../src/VirtualList';
import { TreeView } from '../src/Tree';
import { Tooltip } from '../src/Tooltip';

// VirtualList and Tree drive scrolling from a hand-rolled integrator inside
// update(). The Scene's idle throttle / onDemand skip only keeps rendering
// while some node reports hasPendingAnimations() — these tests pin that the
// integrator is visible to it (the ScrollView 0.2.x regression class).

describe('VirtualList scroll animation visibility', () => {
  function makeList() {
    return new VirtualList({
      items: Array.from({ length: 100 }, (_, i) => `row ${i}`),
      renderItem: () =>
        new (class extends Entity {
          isPointInside() {
            return false;
          }
          render() {}
        })(),
      estimatedRowHeight: 20,
      width: 200,
      height: 100,
    });
  }

  it('reports a pending animation while the scroll spring settles', () => {
    const list = makeList();
    expect(list.hasPendingAnimations()).toBe(false); // at rest initially

    list.scrollToIndex(50);
    expect(list.hasPendingAnimations()).toBe(true); // target far from position

    let t = 0;
    for (let i = 0; i < 600 && list.hasPendingAnimations(); i++) list.update(16, (t += 16));
    expect(list.hasPendingAnimations()).toBe(false); // settles and reports rest
  });

  it('actually reaches the scroll target through update() ticks', () => {
    const list = makeList();
    list.scrollToBottom();
    let t = 0;
    for (let i = 0; i < 600 && list.hasPendingAnimations(); i++) list.update(16, (t += 16));
    // totalH(100×20) - viewport(100) = 1900
    expect((list as unknown as { _scrollY: number })._scrollY).toBeCloseTo(1900, 0);
  });

  it('follows the same trajectory regardless of tick size (dt-aware integrator)', () => {
    // The integrator used to apply a fixed per-call gain (0.12) and decay (0.82),
    // so a 240Hz display settled ~4x faster in wall time than a 60Hz one. With
    // dt-normalized gain/decay/position, a 4.17ms tick and a 16.67ms tick walk
    // the same curve. Exact equality is not asserted: the two discretizations
    // differ by first-order phase error (~5% of the travel distance), so the
    // bound is relative to the distance travelled.
    const a = makeList();
    const b = makeList();
    a.scrollToBottom();
    b.scrollToBottom();
    const travel = (a as unknown as { _targetY: number })._targetY;

    let t = 0;
    for (let s = 0; s < 30; s++) {
      a.update(16.67, t);
      for (let k = 0; k < 4; k++) b.update(4.17, t + k * 4.17);
      t += 16.67;
      const ya = (a as unknown as { _scrollY: number })._scrollY;
      const yb = (b as unknown as { _scrollY: number })._scrollY;
      expect(Math.abs(yb - ya)).toBeLessThanOrEqual(0.08 * travel + 0.5);
    }
  });

  it('settles at the same point after the same wall time regardless of tick size', () => {
    // Normalized settle-step count: a 240Hz tick must need ~4x the steps of a
    // 60Hz tick to cover the same wall time. The old integrator settled after
    // the same NUMBER of steps at any rate (4x faster in wall time at 240Hz).
    // The band (2x..6x) absorbs the snap-threshold sampling noise near rest
    // (one final orbit) while still catching the old 1x-vs-4x defect.
    const a = makeList();
    a.scrollToBottom();
    let ta = 0;
    let stepsA = 0;
    for (; stepsA < 4000 && a.hasPendingAnimations(); stepsA++) a.update(16.67, (ta += 16.67));
    expect(stepsA).toBeGreaterThan(0);

    const b = makeList();
    b.scrollToBottom();
    let tb = 0;
    let stepsB = 0;
    for (; stepsB < 4000 && b.hasPendingAnimations(); stepsB++) b.update(4.17, (tb += 4.17));
    expect(stepsB).toBeGreaterThan(stepsA * 2);
    expect(stepsB).toBeLessThan(stepsA * 6);
    expect((a as unknown as { _scrollY: number })._scrollY).toBeCloseTo(1900, 0);
    expect((b as unknown as { _scrollY: number })._scrollY).toBeCloseTo(1900, 0);
  });
});

describe('Tree scroll animation visibility', () => {
  it('reports a pending animation while the scroll spring settles', () => {
    const tree = new TreeView({
      nodes: Array.from({ length: 100 }, (_, i) => ({ id: `n${i}`, label: `node ${i}` })),
      width: 200,
      height: 100,
    });
    expect(tree.hasPendingAnimations()).toBe(false);

    (tree as unknown as { _targetY: number })._targetY = 500;
    expect(tree.hasPendingAnimations()).toBe(true);

    let t = 0;
    for (let i = 0; i < 600 && tree.hasPendingAnimations(); i++) tree.update(16, (t += 16));
    expect(tree.hasPendingAnimations()).toBe(false);
    expect((tree as unknown as { _scrollY: number })._scrollY).toBeCloseTo(500, 0);
  });

  it('follows the same trajectory regardless of tick size (dt-aware integrator)', () => {
    // Same dt-independence contract as VirtualList above: Tree's integrator
    // applied a fixed per-call gain/decay, so settle speed scaled with refresh
    // rate. Bound is relative to travel (first-order discretization error).
    const a = new TreeView({
      nodes: Array.from({ length: 100 }, (_, i) => ({ id: `n${i}`, label: `node ${i}` })),
      width: 200,
      height: 100,
    });
    const b = new TreeView({
      nodes: Array.from({ length: 100 }, (_, i) => ({ id: `n${i}`, label: `node ${i}` })),
      width: 200,
      height: 100,
    });
    (a as unknown as { _targetY: number })._targetY = 500;
    (b as unknown as { _targetY: number })._targetY = 500;

    let t = 0;
    for (let s = 0; s < 30; s++) {
      a.update(16.67, t);
      for (let k = 0; k < 4; k++) b.update(4.17, t + k * 4.17);
      t += 16.67;
      const ya = (a as unknown as { _scrollY: number })._scrollY;
      const yb = (b as unknown as { _scrollY: number })._scrollY;
      expect(Math.abs(yb - ya)).toBeLessThanOrEqual(0.08 * 500 + 0.5);
    }
  });
});

describe('Tooltip hover timer', () => {
  it('restarts (not stacks) the delay timer on repeated hover', () => {
    vi.useFakeTimers();
    try {
      const target = new (class extends Entity {
        isPointInside() {
          return false;
        }
        render() {}
      })('tip-target');
      const tooltip = new Tooltip({ target, content: 'hi', delay: 100 });
      const showAt = vi.spyOn(tooltip, 'showAt').mockImplementation(() => {});

      target.emit('hover', {});
      vi.advanceTimersByTime(50);
      target.emit('hover', {}); // second hover before the delay elapsed
      vi.advanceTimersByTime(99);
      expect(showAt).not.toHaveBeenCalled(); // first timer was cancelled
      vi.advanceTimersByTime(1);
      expect(showAt).toHaveBeenCalledTimes(1); // exactly one show

      target.emit('hover', {});
      tooltip.destroy(); // must cancel the armed timer
      vi.advanceTimersByTime(1000);
      expect(showAt).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
