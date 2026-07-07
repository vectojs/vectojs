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
