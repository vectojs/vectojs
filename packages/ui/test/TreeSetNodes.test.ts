// @vitest-environment jsdom
//
// Tree.setNodes scroll reset (#688): replacing the nodes kept the old scroll
// offset. With that offset past the new content height, update() settles onto
// the stale target, _visibleRange() returns start > end, and _syncHotspots()
// shrinks its pool toward a NEGATIVE count — an unbounded pop loop that leaves
// the control blank and untappable, with no touch recovery (wheel/drag are the
// only other clamp sites).
//
// NOTE: the settled state is written directly (`_scrollY = _targetY`, exactly
// what update()'s settle branch does) rather than reached through repeated
// update() ticks: a single huge wheel delta makes the integrator overshoot the
// clamped target far enough to hit the same negative-need path mid-flight,
// which would hang the test before the assertion could fail.
import { describe, expect, it } from 'vitest';
import { TreeView } from '../src/Tree';

type Internals = {
  _scrollY: number;
  _targetY: number;
  _hotspots: Array<{ nodeId: string; y: number }>;
};

const internals = (tree: TreeView): Internals => tree as unknown as Internals;

/** Wheel to the bottom, then settle instantly (update()'s settle branch). */
function scrollToBottom(tree: TreeView): void {
  tree.emit('wheel', { deltaY: 1_000_000, preventDefault() {} });
  const t = internals(tree);
  t._scrollY = t._targetY; // the settle branch's assignment, without the flight
}

describe('TreeView.setNodes resets the scroll offset (#688)', () => {
  it('clamps the offset when the replacement is shorter than the viewport', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, label: `row ${i}` }));
    const tree = new TreeView({ nodes: many, width: 200, height: 120 });
    scrollToBottom(tree);
    expect(internals(tree)._scrollY).toBeGreaterThan(0);

    tree.setNodes([{ id: 'x', label: 'only' }]);

    // Offset reset to the new content's range instead of waiting for a wheel.
    expect(internals(tree)._targetY).toBe(0);
    expect(internals(tree)._scrollY).toBe(0);

    // The next frame rebuilds hotspots over real rows — not an empty control.
    tree.update(16, 1000);
    const hotspots = internals(tree)._hotspots;
    expect(hotspots.length).toBeGreaterThan(0);
    expect(hotspots[0]!.nodeId).toBe('x');
    expect(hotspots[0]!.y).toBe(0);
  });

  it('clamps the offset when the replacement is still scrollable', () => {
    const tall = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, label: `row ${i}` }));
    const tree = new TreeView({ nodes: tall, width: 200, height: 120 });
    scrollToBottom(tree);
    expect(internals(tree)._scrollY).toBeGreaterThan(48);

    tree.setNodes(Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, label: `row ${i}` })));
    // 6 rows → content 168, max scroll 48; the stale offset (~1000) clamps.
    expect(internals(tree)._targetY).toBeLessThanOrEqual(48);
    expect(internals(tree)._scrollY).toBe(internals(tree)._targetY);

    tree.update(16, 1000);
    expect(internals(tree)._hotspots.length).toBeGreaterThan(0);
  });
});
