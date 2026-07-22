import { describe, it, expect, vi } from 'vitest';
import { Entity } from '../src/tree/Entity';

class Node extends Entity {
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

describe('Entity lazy allocation', () => {
  it('a fresh entity has no internal collections allocated', () => {
    const e = new Node();
    // Access private fields via index signature for the test only.
    expect((e as any)._drivers).toBeNull();
    expect((e as any).listeners).toBeNull();
    expect((e as any).captureListeners).toBeNull();
    expect((e as any).animations).toBeNull();
  });

  it('behaves identically once collections are used', () => {
    const e = new Node();
    const fn = vi.fn();
    e.on('click', fn);
    e.emit('click', 42);
    expect(fn).toHaveBeenCalledWith(42);
    e.off('click', fn);
    e.emit('click', 7);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('hasPendingAnimations() is false on a fresh entity and safe to call', () => {
    const e = new Node();
    expect(e.hasPendingAnimations()).toBe(false);
    expect(() => e.update(16, 0)).not.toThrow();
  });

  it('destroy() is safe on an entity that never used any collection', () => {
    const e = new Node();
    expect(() => e.destroy()).not.toThrow();
  });

  it('emit/off on an entity with no listeners does not throw', () => {
    const e = new Node();
    expect(() => e.emit('click', 1)).not.toThrow();
    expect(() => e.off('click', () => {})).not.toThrow();
  });
});
