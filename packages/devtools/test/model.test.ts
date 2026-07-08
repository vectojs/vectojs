import { describe, it, expect } from 'vitest';
import { Entity, Scene } from '@vectojs/core';
import { buildTreeModel, findEntityAt, describeEntity, pickInScene } from '../src/model';

class Box extends Entity {
  constructor(id: string, w = 0, h = 0) {
    super(id);
    this.width = w;
    this.height = h;
  }
  isPointInside(): boolean {
    return false; // decorative — picking must fall back to the world AABB
  }
  render(): void {}
}

function makeScene(): Scene {
  const parent = document.createElement('div');
  const canvas = document.createElement('canvas');
  parent.appendChild(canvas);
  return new Scene(canvas, { disableWindowResize: true });
}

describe('buildTreeModel', () => {
  it('mirrors the entity hierarchy with type/geometry labels and an id index', () => {
    const root = new Box('root');
    const parent = new Box('p', 100, 40);
    parent.setPosition(10, 20);
    const child = new Box('c', 8, 8);
    parent.add(child);
    root.add(parent);

    const { nodes, index } = buildTreeModel(root);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].label).toContain('Box');
    expect(nodes[0].label).toContain('(10,20)');
    expect(nodes[0].label).toContain('100×40');
    expect((nodes[0].children as any[])[0].id).toBe('c');
    expect(index.get('p')).toBe(parent);
    expect(index.get('c')).toBe(child);
  });

  it('marks interactive and animating entities with badges', () => {
    const root = new Box('root');
    const hot = new Box('hot', 10, 10);
    hot.interactive = true;
    hot.animate({ x: 50 } as any, 500);
    root.add(hot);

    const { nodes } = buildTreeModel(root);
    expect(nodes[0].label).toContain('⚡');
    expect(nodes[0].label).toContain('▶');
  });
});

describe('findEntityAt', () => {
  it('picks the deepest entity under the point, honoring transforms', () => {
    const root = new Box('root');
    const parent = new Box('p', 200, 200);
    parent.setPosition(100, 100);
    const child = new Box('c', 50, 50);
    child.setPosition(20, 20); // world (120,120)–(170,170)
    parent.add(child);
    root.add(parent);

    expect(findEntityAt(root, 130, 130)?.id).toBe('c'); // inside child
    expect(findEntityAt(root, 110, 110)?.id).toBe('p'); // parent only
    expect(findEntityAt(root, 10, 10)).toBeNull(); // outside everything
  });
});

describe('describeEntity', () => {
  it('reports geometry, transform, and animation state as readable lines', () => {
    const e = new Box('d', 30, 10);
    e.setPosition(5, 6);
    e.opacity = 0.5;
    const lines = describeEntity(e);
    expect(lines[0]).toContain('#d');
    expect(lines.join('\n')).toContain('x 5');
    expect(lines.join('\n')).toContain('op 0.5');
    expect(lines.join('\n')).toContain('animating false');
  });
});

describe('pickInScene', () => {
  it('prefers overlay entities over the main tree', () => {
    const scene = makeScene();
    const under = new Box('under', 100, 100);
    scene.add(under);
    const over = new Box('over', 100, 100);
    scene.showOverlay(over);

    expect(pickInScene(scene, 50, 50)?.id).toBe('over');
    scene.destroy();
  });
});
