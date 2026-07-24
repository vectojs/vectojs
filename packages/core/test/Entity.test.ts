import { describe, it, expect, vi } from 'vitest';
import { Entity } from '../src/tree/Entity';

// Entity is abstract; use a minimal concrete subclass for tests.
class TestEntity extends Entity {
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

describe('Entity Component System', () => {
  it('should manage children correctly', () => {
    const parent = new TestEntity('parent');
    const child = new TestEntity('child');

    parent.add(child);
    expect(parent.children.length).toBe(1);
    expect(child.parent).toBe(parent);

    parent.remove(child);
    expect(parent.children.length).toBe(0);
    expect(child.parent).toBeNull();
  });

  it('adding an already-added child again does not duplicate it in children[]', () => {
    const parent = new TestEntity('parent');
    const child = new TestEntity('child');

    parent.add(child);
    parent.add(child);

    expect(parent.children.length).toBe(1);
    expect(child.parent).toBe(parent);

    // A single remove() must fully detach it — not leave a stale duplicate
    // entry that keeps rendering/updating despite child.parent being null.
    parent.remove(child);
    expect(parent.children.length).toBe(0);
    expect(child.parent).toBeNull();
  });

  it('re-parenting a child to a new parent detaches it from the old one', () => {
    const parentA = new TestEntity('a');
    const parentB = new TestEntity('b');
    const child = new TestEntity('child');

    parentA.add(child);
    parentB.add(child);

    expect(child.parent).toBe(parentB);
    expect(parentB.children).toContain(child);
    // The old parent must not keep a stale reference whose own .parent
    // disagrees with where it actually lives now.
    expect(parentA.children).not.toContain(child);
  });

  it('should compute global position correctly', () => {
    const parent = new TestEntity();
    parent.setPosition(100, 100);

    const child = new TestEntity();
    child.setPosition(50, 50);

    parent.add(child);

    const globalPos = child.getGlobalPosition();
    expect(globalPos.x).toBe(150);
    expect(globalPos.y).toBe(150);
  });

  it('should emit events correctly', () => {
    const entity = new TestEntity();
    const mockHandler = vi.fn();

    entity.on('click', mockHandler);
    entity.emit('click', { type: 'click' });

    expect(mockHandler).toHaveBeenCalledTimes(1);
  });

  it('should chain add() calls fluently', () => {
    const parent = new TestEntity();
    const a = new TestEntity();
    const b = new TestEntity();
    parent.add(a).add(b);
    expect(parent.children.length).toBe(2);
  });

  it('should compute deeply nested global position', () => {
    const grandparent = new TestEntity();
    grandparent.setPosition(50, 50);
    const parent = new TestEntity();
    parent.setPosition(20, 20);
    const child = new TestEntity();
    child.setPosition(10, 10);
    grandparent.add(parent);
    parent.add(child);
    const pos = child.getGlobalPosition();
    expect(pos.x).toBe(80);
    expect(pos.y).toBe(80);
  });

  it('off() removes a specific listener', () => {
    const entity = new TestEntity();
    const handler = vi.fn();
    entity.on('click', handler);
    entity.off('click', handler);
    entity.emit('click', {});
    expect(handler).not.toHaveBeenCalled();
  });

  it('destroy() clears listeners and detaches from parent', () => {
    const parent = new TestEntity();
    const child = new TestEntity();
    const handler = vi.fn();
    parent.add(child);
    child.on('click', handler);
    child.destroy();
    expect(parent.children.length).toBe(0);
    child.emit('click', {});
    expect(handler).not.toHaveBeenCalled();
  });

  describe('destroy() recurses into the subtree', () => {
    // A subclass that records its own teardown, standing in for the real
    // subclasses that free GPU buffers / workers / observers in destroy().
    class ResourceEntity extends TestEntity {
      public destroyed = false;
      override destroy(): void {
        this.destroyed = true;
        super.destroy();
      }
    }

    it('tears down every descendant (leaf-first), not just the root', () => {
      const root = new ResourceEntity('root');
      const child = new ResourceEntity('child');
      const grandchild = new ResourceEntity('grandchild');
      root.add(child);
      child.add(grandchild);

      root.destroy();

      expect(root.destroyed).toBe(true);
      expect(child.destroyed).toBe(true);
      expect(grandchild.destroyed).toBe(true);
      // Whole subtree detached.
      expect(root.children.length).toBe(0);
      expect(child.children.length).toBe(0);
      expect(child.parent).toBeNull();
      expect(grandchild.parent).toBeNull();
    });

    it('destroys children before the parent releases its own state (leaf-first order)', () => {
      const order: string[] = [];
      class OrderedEntity extends TestEntity {
        constructor(private label: string) {
          super();
        }
        override destroy(): void {
          order.push(this.label);
          super.destroy();
        }
      }
      const root = new OrderedEntity('root');
      const child = new OrderedEntity('child');
      const grandchild = new OrderedEntity('grandchild');
      root.add(child);
      child.add(grandchild);

      root.destroy();

      // Each parent's own destroy body runs, then it recurses — so the deepest
      // descendant finishes teardown before the root detaches from its parent.
      expect(order).toEqual(['root', 'child', 'grandchild']);
    });

    it('base teardown + recursion run once even when destroy() is called repeatedly', () => {
      // The base guard short-circuits the *recursion and base teardown* on any
      // repeat call, so descendants are never walked twice. Subclasses free
      // their own resources idempotently (they null their handles); this
      // ResourceEntity models that by flipping a boolean.
      const root = new ResourceEntity('root');
      const child = new ResourceEntity('child');
      const grandchild = new ResourceEntity('grandchild');
      root.add(child);
      child.add(grandchild);

      root.destroy();
      root.destroy(); // no-op: guard already tripped
      child.destroy(); // no-op: reached + destroyed via the first subtree walk
      grandchild.destroy(); // guard short-circuits the base body

      expect(root.destroyed).toBe(true);
      expect(child.destroyed).toBe(true);
      expect(grandchild.destroyed).toBe(true);
      expect(grandchild.parent).toBeNull();
      expect(root.children.length).toBe(0);
    });

    it('re-entrant destroy from within a subclass teardown does not double-recurse', () => {
      // Models the ContextMenu pattern: a subclass explicitly destroys a node
      // that is *also* one of its children, then calls super.destroy() which
      // recurses the children. The guard makes the recursive re-hit a no-op, so
      // the shared node's base teardown runs exactly once.
      class Panel extends TestEntity {
        readonly backdrop = new TestEntity('backdrop');
        constructor() {
          super();
          this.add(this.backdrop);
        }
        override destroy(): void {
          this.backdrop.destroy(); // explicit teardown (backdrop is also a child)
          super.destroy(); // recurses children -> reaches backdrop again
        }
      }
      const grandchild = new TestEntity('leaf');
      const panel = new Panel();
      panel.backdrop.add(grandchild);
      const walkSpy = vi.spyOn(grandchild, 'destroy');

      expect(() => panel.destroy()).not.toThrow();

      // The leaf's base teardown ran exactly once despite the backdrop being
      // destroyed both explicitly and via recursion.
      expect(walkSpy).toHaveBeenCalledTimes(1);
      expect(grandchild.parent).toBeNull();
    });

    it('destroying a mid-tree node detaches only that subtree, leaving siblings intact', () => {
      const root = new TestEntity('root');
      const branchA = new TestEntity('a');
      const branchB = new TestEntity('b');
      const leafA = new TestEntity('leafA');
      root.add(branchA, branchB);
      branchA.add(leafA);

      branchA.destroy();

      expect(root.children).toEqual([branchB]);
      expect(branchA.parent).toBeNull();
      expect(leafA.parent).toBeNull();
    });
  });

  it('animate() queue and step-by-step update interpolation', () => {
    const entity = new TestEntity();
    entity.x = 100;

    // Start animation
    entity.animate({ x: 200 } as any, 100);

    // First frame initialization (time = 0)
    entity.update(0, 0);
    expect(entity.x).toBe(100);

    // Half way (time = 50)
    // progress = 0.5, easeOut = 0.5 * (2 - 0.5) = 0.75
    // value = 100 + (200 - 100) * 0.75 = 175
    entity.update(50, 50);
    expect(entity.x).toBe(175);

    // Finished (time = 100)
    entity.update(50, 100);
    expect(entity.x).toBe(200);
  });

  it('should compute global position under parent scale and rotation', () => {
    const parent = new TestEntity();
    parent.setPosition(100, 100);
    parent.scaleX = 2;
    parent.scaleY = 0.5;
    parent.rotation = Math.PI / 2;

    const child = new TestEntity();
    child.setPosition(50, 0);

    parent.add(child);

    // Matches the Canvas T*S*R order used by Scene.loop:
    // R(50,0)@90° = (0,50); S(0,50) with (2,0.5) = (0,25); + parent (100,100) = (100,125).
    const pos = child.getGlobalPosition();
    expect(pos.x).toBeCloseTo(100);
    expect(pos.y).toBeCloseTo(125);
  });

  it('non-uniform scale + rotation matches Canvas T*S*R transform', () => {
    const parent = new TestEntity();
    parent.setPosition(0, 0);
    parent.scaleX = 3;
    parent.scaleY = 5;
    parent.rotation = Math.PI / 2;

    const child = new TestEntity();
    child.setPosition(10, 20);
    parent.add(child);

    // R(10,20)@90° = (-20,10); S with (3,5) = (-60,50); + parent (0,0) = (-60,50).
    const pos = child.getGlobalPosition();
    expect(pos.x).toBeCloseTo(-60);
    expect(pos.y).toBeCloseTo(50);
  });

  it('getBounds() defaults to null (never culled)', () => {
    expect(new TestEntity().getBounds()).toBeNull();
  });

  it('hasPendingAnimations() is true mid-tween and false after it finishes', () => {
    const e = new TestEntity();
    e.x = 0;
    expect(e.hasPendingAnimations()).toBe(false);
    e.animate({ x: 100 } as any, 100);
    expect(e.hasPendingAnimations()).toBe(true);
    e.update(0, 0); // init
    e.update(50, 50); // mid
    expect(e.hasPendingAnimations()).toBe(true);
    e.update(50, 100); // complete
    expect(e.hasPendingAnimations()).toBe(false);
  });

  describe('Entity getWorldRotation', () => {
    it('calculates accumulated rotation up the tree', () => {
      const parent = new TestEntity('parent');
      parent.rotation = 0.5;
      const child = new TestEntity('child');
      child.rotation = 0.2;
      parent.add(child);
      expect(child.getWorldRotation()).toBeCloseTo(0.7);
    });
  });
});
