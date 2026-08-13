// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Entity, Scene } from '../src/index';

class Box extends Entity {
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

function makeScene(): Scene {
  const ctx = {
    scale: vi.fn(),
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    measureText: (t: string) => ({ width: t.length * 8 }),
    canvas: null as unknown,
    globalAlpha: 1,
    fillStyle: '',
  };
  const canvas = document.createElement('canvas');
  canvas.width = 400;
  canvas.height = 300;
  (canvas as unknown as { getContext: () => unknown }).getContext = () => ctx;
  ctx.canvas = canvas;
  const scene = new Scene(canvas, { disableWindowResize: true });
  return scene;
}

/** The batched-driver candidate set, which tests may read but not write. */
function active(scene: Scene): Set<Entity> {
  return (scene as unknown as { _activeDriverEntities: Set<Entity> })._activeDriverEntities;
}

describe('Entity.remove and the batched-driver candidate registry', () => {
  it('unregisters the removed subtree from the batched-driver set', () => {
    const scene = makeScene();
    const parent = new Box('p');
    const child = new Box('c');
    const grandchild = new Box('g');
    scene.add(parent);
    parent.add(child);
    child.add(grandchild);

    // A live batched driver registers its entity (and only it).
    child.animateTo({ x: 100 }, { duration: 1000, easing: 'linear' });
    grandchild.animateTo({ x: 50 }, { duration: 1000, easing: 'linear' });
    expect(active(scene).has(child)).toBe(true);
    expect(active(scene).has(grandchild)).toBe(true);

    // Removing the CHILD through the tree node must drop its whole subtree —
    // off-tree entities whose drivers still have time remaining would
    // otherwise keep ticking on the batch path every frame until completion.
    parent.remove(child);
    expect(active(scene).has(child)).toBe(false);
    expect(active(scene).has(grandchild)).toBe(false);
  });

  it('re-registers the subtree when a removed node is re-attached mid-animation', () => {
    const scene = makeScene();
    const parent = new Box('p');
    const child = new Box('c');
    const grandchild = new Box('g');
    scene.add(parent);
    parent.add(child);
    child.add(grandchild);

    child.animateTo({ x: 100 }, { duration: 1000, easing: 'linear' });
    grandchild.animateTo({ x: 50 }, { duration: 1000, easing: 'linear' });
    parent.remove(child);
    expect(active(scene).has(child)).toBe(false);
    expect(active(scene).has(grandchild)).toBe(false);

    // Re-attaching resumes the still-live drivers on the batch path.
    parent.add(child);
    expect(active(scene).has(child)).toBe(true);
    expect(active(scene).has(grandchild)).toBe(true);
  });

  it('registers live drivers for a subtree attached after the drivers spawned', () => {
    const scene = makeScene();
    const parent = new Box('p');
    const child = new Box('c');
    scene.add(parent);

    // Spawned off-tree (no scene on the chain), so registration never fired.
    child.animateTo({ x: 100 }, { duration: 1000, easing: 'linear' });
    expect(active(scene).has(child)).toBe(false);

    // Attaching must walk the subtree and register anything still animating.
    parent.add(child);
    expect(active(scene).has(child)).toBe(true);
  });

  it('leaves a detached parent-and-child pair unregistered when the parent is removed', () => {
    const scene = makeScene();
    const top = new Box('top');
    const parent = new Box('p');
    const child = new Box('c');
    scene.add(top);
    top.add(parent);
    parent.add(child);
    child.animateTo({ x: 10 }, { duration: 1000, easing: 'linear' });
    expect(active(scene).has(child)).toBe(true);

    // Scene-level remove routes through Entity.remove; the subtree must go too.
    scene.remove(top);
    expect(active(scene).has(child)).toBe(false);
  });
});
