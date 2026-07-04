import { describe, it, expect } from 'vitest';
import { Entity } from '../src/tree/Entity';

class Probe extends Entity {
  mounted = 0;
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
  protected override onMounted(): void {
    this.mounted++;
  }
}

// Minimal live-scene stand-in: add() calls markDirty() and sets a11yNeedsReorder.
const mockScene = () => ({ markDirty() {}, a11yNeedsReorder: false });
const setScene = (e: Entity, s: unknown) => {
  (e as unknown as { _scene: unknown })._scene = s;
};

describe('mount hook', () => {
  it('fires when attached under a live-scene parent, once', () => {
    const root = new Probe();
    setScene(root, mockScene());
    const child = new Probe();
    root.add(child);
    expect(child.mounted).toBe(1);
  });

  it('does not fire when the parent has no scene yet', () => {
    const parent = new Probe();
    const child = new Probe();
    parent.add(child);
    expect(child.mounted).toBe(0);
  });

  it('fires for a whole subtree when its root is attached to a live scene', () => {
    const liveRoot = new Probe();
    setScene(liveRoot, mockScene());
    const branch = new Probe();
    const leaf = new Probe();
    branch.add(leaf); // parent not live yet -> no fire
    expect(leaf.mounted).toBe(0);
    liveRoot.add(branch); // now the whole subtree goes live
    expect(branch.mounted).toBe(1);
    expect(leaf.mounted).toBe(1);
  });
});
