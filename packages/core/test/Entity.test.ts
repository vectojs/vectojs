import { describe, it, expect, vi } from 'vitest';
import { Entity } from '../src/tree/Entity';
import { Scene } from '../src/tree/Scene';

describe('Entity Component System', () => {
  it('should manage children correctly', () => {
    const parent = new Entity('parent');
    const child = new Entity('child');

    parent.add(child);
    expect(parent.children.length).toBe(1);
    expect(child.parent).toBe(parent);

    parent.remove(child);
    expect(parent.children.length).toBe(0);
    expect(child.parent).toBeNull();
  });

  it('should compute global position correctly', () => {
    const parent = new Entity();
    parent.setPosition(100, 100);

    const child = new Entity();
    child.setPosition(50, 50);

    parent.add(child);

    const globalPos = child.getGlobalPosition();
    expect(globalPos.x).toBe(150);
    expect(globalPos.y).toBe(150);
  });

  it('should emit events correctly', () => {
    const entity = new Entity();
    const mockHandler = vi.fn();

    entity.on('click', mockHandler);
    entity.emit('click', { type: 'click' });

    expect(mockHandler).toHaveBeenCalledTimes(1);
  });

  it('should chain add() calls fluently', () => {
    const parent = new Entity();
    const a = new Entity();
    const b = new Entity();
    parent.add(a).add(b);
    expect(parent.children.length).toBe(2);
  });

  it('should compute deeply nested global position', () => {
    const grandparent = new Entity();
    grandparent.setPosition(50, 50);
    const parent = new Entity();
    parent.setPosition(20, 20);
    const child = new Entity();
    child.setPosition(10, 10);
    grandparent.add(parent);
    parent.add(child);
    const pos = child.getGlobalPosition();
    expect(pos.x).toBe(80);
    expect(pos.y).toBe(80);
  });

  it('off() removes a specific listener', () => {
    const entity = new Entity();
    const handler = vi.fn();
    entity.on('click', handler);
    entity.off('click', handler);
    entity.emit('click', {});
    expect(handler).not.toHaveBeenCalled();
  });

  it('destroy() clears listeners and detaches from parent', () => {
    const parent = new Entity();
    const child = new Entity();
    const handler = vi.fn();
    parent.add(child);
    child.on('click', handler);
    child.destroy();
    expect(parent.children.length).toBe(0);
    child.emit('click', {});
    expect(handler).not.toHaveBeenCalled();
  });

  it('animate() queue and step-by-step update interpolation', () => {
    const entity = new Entity();
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
    const parent = new Entity();
    parent.setPosition(100, 100);
    parent.scaleX = 2;
    parent.scaleY = 0.5;
    parent.rotation = Math.PI / 2;

    const child = new Entity();
    child.setPosition(50, 0);

    parent.add(child);

    const pos = child.getGlobalPosition();
    expect(pos.x).toBeCloseTo(100);
    expect(pos.y).toBeCloseTo(200);
  });
});
