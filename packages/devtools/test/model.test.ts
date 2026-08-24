import { describe, it, expect } from 'vitest';
import { Entity, Scene } from '@vectojs/core';
import {
  buildTreeModel,
  findEntityAt,
  describeEntity,
  pickInScene,
  refreshTreeLabels,
} from '../src/model';

class Box extends Entity {
  constructor(id: string, w = 0, h = 0) {
    super(id);
    this.width = w;
    this.height = h;
  }
  // Rect semantics, like every concrete engine shape: a point inside the
  // local box hits, anything else declines (#671 — no AABB fallback here or
  // in the picker).
  isPointInside(sceneX: number, sceneY: number): boolean {
    const point = this.worldToLocal(sceneX, sceneY);
    return (
      point !== null &&
      point.x >= 0 &&
      point.y >= 0 &&
      point.x < this.width &&
      point.y < this.height
    );
  }
  render(): void {}
}

/** Shape that always declines — a particle (`pointerEvents=false`) or any
 *  entity whose geometry rejects points inside its world box. Production
 *  HitTester never returns these; neither may the picker. */
class DecliningBox extends Box {
  override isPointInside(): boolean {
    return false;
  }
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

  it('refreshTreeLabels rewrites geometry in place and reports what changed', () => {
    const root = new Box('root');
    const moved = new Box('m', 40, 20);
    moved.setPosition(5, 6);
    root.add(moved);

    const { nodes, index } = buildTreeModel(root);
    expect(nodes[0].label).toContain('(5,6)');

    // Transforms never bump the scene's structure version, so the version gate
    // would otherwise show the coordinates of the last structural change until
    // the periodic forced reconcile — up to 3s stale (#706).
    moved.setPosition(90, -4);
    const changed = refreshTreeLabels(nodes, index);
    expect(changed).toBe(true);
    expect(nodes[0].label).toContain('(90,-4)');
    expect(nodes[0].id).toBe('m'); // same node object, mutated in place

    // Nothing moved: no change to report, callers can skip redraw work.
    expect(refreshTreeLabels(nodes, index)).toBe(false);
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

  it('does not pick an entity whose shape declines inside its own box', () => {
    const root = new Box('root');
    const particle = new DecliningBox('particle', 80, 80);
    particle.setPosition(10, 10);
    root.add(particle);

    // Inside the world AABB but rejected by the shape: production
    // findHitRecursively returns nothing here, so the picker must too —
    // the old AABB fallback reported a false owner (#671).
    expect(findEntityAt(root, 50, 50)).toBeNull();
  });

  it('falls through a declining shape to the hittable entity beneath it', () => {
    const root = new Box('root');
    const backdrop = new Box('backdrop', 200, 200);
    const overlay = new DecliningBox('overlay', 200, 200);
    overlay.setPosition(0, 0);
    root.add(backdrop);
    root.add(overlay); // drawn after → topmost

    // A real click resolves the backdrop; the picker must agree.
    expect(findEntityAt(root, 150, 150)?.id).toBe('backdrop');
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

  it('skips an opacity-0 overlay and returns the visible entity beneath it', () => {
    const scene = makeScene();
    const under = new Box('under', 100, 100);
    scene.add(under);
    const ghost = new Box('ghost', 100, 100);
    ghost.opacity = 0;
    scene.showOverlay(ghost);

    // An invisible overlay covers the point, but the engine's hit test rejects
    // an opacity-0 subtree and falls through to the visible entity — the
    // inspector must agree or it reports the entity a click could never hit.
    expect(pickInScene(scene, 50, 50)?.id).toBe('under');
    scene.destroy();
  });
});
