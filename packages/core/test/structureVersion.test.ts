// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Entity, Scene } from '../src/index';

/**
 * `Scene.structureVersion` — the contract DevTools replaced polling with.
 *
 * It must bump on every shape change and stay put for property changes, or a
 * consumer caching the tree either shows a stale view or gains nothing.
 */
class Box extends Entity {
  public override render(): void {}
}

function makeScene(): Scene {
  const canvas = document.createElement('canvas');
  canvas.width = 200;
  canvas.height = 200;
  (canvas as unknown as { getContext: () => unknown }).getContext = () => ({
    measureText: (t: string) => ({ width: String(t).length * 8 }),
    canvas,
    save() {},
    restore() {},
    translate() {},
    scale() {},
    clearRect() {},
    fillRect() {},
    fillText() {},
    beginPath() {},
    setTransform() {},
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  });
  document.body.appendChild(canvas);
  const scene = new Scene(canvas, { disableWindowResize: true });
  scene.resize(200, 200);
  return scene;
}

describe('Scene.structureVersion', () => {
  it('bumps when an entity is added', () => {
    const scene = makeScene();
    const before = scene.structureVersion;
    scene.add(new Box());
    expect(scene.structureVersion).toBeGreaterThan(before);
  });

  it('bumps when an entity is removed', () => {
    const scene = makeScene();
    const box = new Box();
    scene.add(box);
    const before = scene.structureVersion;
    scene.remove(box);
    expect(scene.structureVersion).toBeGreaterThan(before);
  });

  it('bumps for a nested add, not just a direct child', () => {
    const scene = makeScene();
    const parent = new Box();
    scene.add(parent);
    const before = scene.structureVersion;
    parent.add(new Box());
    expect(scene.structureVersion).toBeGreaterThan(before);
  });

  it('does not bump for a property change', () => {
    const scene = makeScene();
    const box = new Box();
    scene.add(box);
    const before = scene.structureVersion;
    box.setPosition(10, 20);
    box.opacity = 0.5;
    box.width = 99;
    // A consumer that caches the tree's SHAPE must not be invalidated by a move;
    // if it also cares about values it has to read those directly.
    expect(scene.structureVersion).toBe(before);
  });

  it('does not bump for a plain markDirty', () => {
    const scene = makeScene();
    scene.add(new Box());
    const before = scene.structureVersion;
    scene.markDirty();
    expect(scene.structureVersion).toBe(before);
  });
});
