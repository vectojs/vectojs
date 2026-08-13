// @vitest-environment jsdom
//
// Tree lazy-load failure: a children() promise that rejects must not strand
// the row in the "loading" state, and the rejection must be handled rather
// than surfacing as an unhandled promise rejection (which is a process-level
// failure in every modern runtime, not merely a visual glitch).
import { describe, expect, it, vi } from 'vitest';
import { TreeView } from '../src/Tree';

const loadingOf = (tree: TreeView): Set<string> =>
  (tree as unknown as { _loading: Set<string> })._loading;
const expandedOf = (tree: TreeView): Set<string> =>
  (tree as unknown as { _expanded: Set<string> })._expanded;
const rowsOf = (tree: TreeView): Array<{ node: { id: string }; loading: boolean }> =>
  (tree as unknown as { _rows: Array<{ node: { id: string }; loading: boolean }> })._rows;

/** Tap the row at `localY` (a pointerdown+up pair counts as a tap → toggle). */
function tap(tree: TreeView, localY = 0): void {
  tree.emit('pointerdown', { localY });
  tree.emit('pointerup', { localY });
}

describe('TreeView lazy load', () => {
  it('clears the loading state when a lazy load rejects', async () => {
    const children = vi.fn().mockRejectedValue(new Error('boom'));
    const tree = new TreeView({
      nodes: [{ id: 'p', label: 'parent', children }],
      width: 200,
      height: 120,
    });

    tap(tree, 0);
    // The row enters the loading state while the promise is in flight.
    expect(loadingOf(tree).has('p')).toBe(true);
    expect(rowsOf(tree)[0]!.loading).toBe(true);

    // The rejection settles: loading clears and the row is rebuilt without
    // the flag. (The unhandled rejection itself fails this test on the old
    // code even before the assertions run.)
    await vi.waitFor(() => {
      expect(loadingOf(tree).size).toBe(0);
    });
    expect(rowsOf(tree)[0]!.loading).toBe(false);
    // Collapsed on failure so a retry is one click away; the next expand
    // re-attempts the load.
    expect(expandedOf(tree).has('p')).toBe(false);
  });

  it('retries a failed lazy load on the next expand', async () => {
    let fail = true;
    const children = vi.fn().mockImplementation(async () => {
      if (fail) throw new Error('first attempt fails');
      return [{ id: 'c', label: 'child' }];
    });
    const tree = new TreeView({
      nodes: [{ id: 'p', label: 'parent', children }],
      width: 200,
      height: 120,
    });

    tap(tree, 0);
    await vi.waitFor(() => {
      expect(loadingOf(tree).size).toBe(0);
    });
    expect(rowsOf(tree)).toHaveLength(1); // still collapsed: no children yet

    fail = false;
    tap(tree, 0);
    await vi.waitFor(() => {
      expect(children).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() => {
      expect(loadingOf(tree).size).toBe(0);
    });
    expect(rowsOf(tree).some((r) => r.node.id === 'c')).toBe(true);
  });
});
