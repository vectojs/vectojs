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
});
