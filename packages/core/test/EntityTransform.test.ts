import { describe, expect, it } from 'vitest';
import { Entity } from '../src/tree/Entity';

class Node extends Entity {
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

function applyLocalTransform(entity: Entity, x: number, y: number) {
  const cos = Math.cos(entity.rotation);
  const sin = Math.sin(entity.rotation);
  return {
    x: entity.x + entity.scaleX * (x * cos - y * sin),
    y: entity.y + entity.scaleY * (x * sin + y * cos),
  };
}

describe('Entity affine coordinate conversion', () => {
  it('round-trips through nested rotation and non-uniform scale', () => {
    const parent = new Node('parent');
    parent.setPosition(100, 50);
    parent.scaleX = 2;
    parent.scaleY = 3;
    parent.rotation = 0.4;

    const child = new Node('child');
    child.setPosition(10, -5);
    child.scaleX = 0.5;
    child.scaleY = 1.5;
    child.rotation = -0.2;
    parent.add(child);

    const local = { x: 17, y: 23 };
    const inParent = applyLocalTransform(child, local.x, local.y);
    const expectedWorld = applyLocalTransform(parent, inParent.x, inParent.y);

    const world = child.localToWorld(local.x, local.y);
    expect(world.x).toBeCloseTo(expectedWorld.x, 9);
    expect(world.y).toBeCloseTo(expectedWorld.y, 9);

    const roundTrip = child.worldToLocal(world.x, world.y);
    expect(roundTrip?.x).toBeCloseTo(local.x, 9);
    expect(roundTrip?.y).toBeCloseTo(local.y, 9);
  });

  it('returns null when the accumulated transform is singular', () => {
    const node = new Node();
    node.scaleX = 0;
    expect(node.worldToLocal(10, 20)).toBeNull();
  });

  it('returns the world-space axis-aligned box for transformed local bounds', () => {
    const node = new Node();
    node.setPosition(100, 50);
    node.width = 20;
    node.height = 10;
    node.scaleX = 2;
    node.rotation = Math.PI / 2;

    expect(node.getWorldBounds()).toEqual({ x: 80, y: 50, width: 20, height: 20 });
  });
});
