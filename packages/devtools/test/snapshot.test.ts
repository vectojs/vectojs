import { describe, it, expect } from 'vitest';
import { Entity, Scene } from '@vectojs/core';
import { captureSnapshot, diffSnapshots } from '../src/snapshot';

class Box extends Entity {
  constructor(id: string, w = 0, h = 0) {
    super(id);
    this.width = w;
    this.height = h;
  }
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

class Lbl extends Box {
  public text = 'caption';
}

function makeScene(): Scene {
  const parent = document.createElement('div');
  const canvas = document.createElement('canvas');
  parent.appendChild(canvas);
  return new Scene(canvas, { disableWindowResize: true });
}

describe('captureSnapshot', () => {
  it('captures the tree with world geometry, omitting default-valued flags', () => {
    const scene = makeScene();
    scene.resize(400, 300);
    const card = new Box('card', 100, 40);
    card.setPosition(10, 20);
    const label = new Lbl('label', 80, 20);
    label.interactive = true;
    card.add(label);
    scene.add(card);

    const snap = captureSnapshot(scene);
    expect(snap.width).toBe(400);
    expect(snap.root).toHaveLength(1);
    const cardNode = snap.root[0];
    expect(cardNode.type).toBe('Box');
    expect(cardNode.worldBounds).toEqual({ x: 10, y: 20, width: 100, height: 40 });
    expect(cardNode.opacity).toBeUndefined(); // 1 → omitted
    expect(cardNode.interactive).toBeUndefined(); // false → omitted
    const labelNode = cardNode.children![0];
    expect(labelNode.text).toBe('caption');
    expect(labelNode.interactive).toBe(true);
    expect(snap.overlay).toEqual([]);
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
    scene.destroy();
  });

  it('is deterministic: two captures of an unchanged scene are deep-equal', () => {
    const scene = makeScene();
    scene.resize(400, 300);
    scene.add(new Box('a', 50, 50));
    scene.add(new Box('b', 60, 60));

    expect(captureSnapshot(scene)).toEqual(captureSnapshot(scene));
    scene.destroy();
  });
});

describe('diffSnapshots', () => {
  it('returns empty for identical scenes and property-level changes for moves', () => {
    const scene = makeScene();
    scene.resize(400, 300);
    const box = new Box('m', 50, 50);
    scene.add(box);

    const before = captureSnapshot(scene);
    expect(diffSnapshots(before, captureSnapshot(scene))).toEqual([]);

    box.setPosition(30, 0);
    const diffs = diffSnapshots(before, captureSnapshot(scene));
    expect(diffs).toHaveLength(1);
    expect(diffs[0].kind).toBe('changed');
    expect(diffs[0].path).toBe('root > Box[0]');
    expect(diffs[0].changes?.x).toEqual({ from: 0, to: 30 });
    expect(diffs[0].changes?.worldBounds).toBeDefined();
    scene.destroy();
  });

  it('reports added and removed nodes by structural path, not id', () => {
    const scene = makeScene();
    scene.resize(400, 300);
    scene.add(new Box('a', 50, 50));
    const before = captureSnapshot(scene);

    scene.add(new Lbl('late', 20, 10));
    const withAdd = diffSnapshots(before, captureSnapshot(scene));
    expect(withAdd).toHaveLength(1);
    expect(withAdd[0]).toMatchObject({ kind: 'added', path: 'root > Lbl[1]' });

    const removed = diffSnapshots(captureSnapshot(scene), before);
    expect(removed).toHaveLength(1);
    expect(removed[0].kind).toBe('removed');
    scene.destroy();
  });
});
