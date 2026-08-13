// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Entity } from '@vectojs/core';
import { VirtualList } from '../src/VirtualList';

class TagRow extends Entity {
  tag = '';
  constructor(tag: string) {
    super();
    this.tag = tag;
    this.height = 20;
  }
  public override isPointInside(): boolean {
    return false;
  }
  public override render(): void {}
}

function makeList(items: string[], opts: { keyed?: boolean } = {}) {
  const list = new VirtualList<string>({
    items,
    renderItem: (item) => new TagRow(item),
    estimatedRowHeight: 20,
    width: 100,
    height: 100,
    overscan: 0,
    ...(opts.keyed === false ? {} : { keyForItem: (item: string) => item }),
  });
  // Drive one tick so the initial mount + measurement pass runs.
  list.update(16, 16);
  return list;
}

describe('VirtualList setItems', () => {
  it('replaces row content in the unkeyed path (regression for stale pool reuse)', () => {
    // Build a list with 3 visible rows (no keyForItem), then replace the items array.
    // Before the fix, the unkeyed branch reset scroll but never cleared _pool, so
    // _reconcile reused the pooled entities without calling renderItem again — every
    // overlapping index kept the OLD item's content.
    const list = makeList(['A', 'B', 'C'], { keyed: false });

    // Verify initial render
    const before = list.children.map((c) => (c as TagRow).tag);
    expect(before).toEqual(['A', 'B', 'C']);

    // Replace items
    list.setItems(['X', 'Y', 'Z']);
    list.update(16, 32);

    // After the fix, the rows show the NEW items.
    const after = list.children.map((c) => (c as TagRow).tag);
    expect(after).toEqual(['X', 'Y', 'Z']);
  });

  it('keyed path already works (rekey maintains key↔entity identity)', () => {
    // The keyed path was always correct because _rekeyPool preserves identity.
    const list = makeList(['A', 'B', 'C'], { keyed: true });

    const before = list.children.map((c) => (c as TagRow).tag);
    expect(before).toEqual(['A', 'B', 'C']);

    list.setItems(['X', 'Y', 'Z']);
    list.update(16, 32);

    const after = list.children.map((c) => (c as TagRow).tag);
    expect(after).toEqual(['X', 'Y', 'Z']);
  });

  it('resets scroll to top in the unkeyed path', () => {
    // Existing test coverage verifies scroll reset; this confirms it still works.
    const list = makeList(
      Array.from({ length: 50 }, (_, i) => `item-${i}`),
      { keyed: false },
    );
    const priv = list as unknown as { _scrollY: number; _targetY: number };

    // Scroll down using internal state
    priv._targetY = 500;
    priv._scrollY = 500;
    list.update(16, 32);
    expect(priv._scrollY).toBeGreaterThan(0);

    // setItems resets scroll
    list.setItems(['new-0', 'new-1', 'new-2']);
    expect(priv._targetY).toBe(0);
    expect(priv._scrollY).toBe(0);
  });

  it('zeroes scroll velocity in the unkeyed path (no transient overshoot after a replace)', () => {
    const list = makeList(
      Array.from({ length: 500 }, (_, i) => `item-${i}`),
      { keyed: false },
    );
    const priv = list as unknown as { _scrollY: number; _velY: number };

    // Build real downward scroll velocity mid-flight (wheel + integrator).
    list.emit('wheel', { deltaY: 200, preventDefault() {} });
    for (let i = 0; i < 40; i++) list.update(16, 40 + i * 16);
    expect(Math.abs(priv._velY)).toBeGreaterThan(0.05); // precondition: in flight

    // Replacing the list resets scroll to the top; the stale velocity must not
    // survive into the new list, or the first update() carries the old flick
    // and `_scrollY` overshoots past the content edge.
    list.setItems(['X', 'Y', 'Z']);
    list.update(16, 4000);
    expect(priv._scrollY).toBe(0);
  });
});
