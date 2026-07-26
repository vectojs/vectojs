// @vitest-environment jsdom
// Fused hit-grid gather: AABBs read from the WASM transform store instead of
// recomputed in JS.
//
// The WASM hit kernel is 65-170x faster than the JS depth-first walk, yet the
// integrated path measured SLOWER for an ordinary hover — 11.2ms vs 39us at 100k
// entities — because a JS gather ran in front of it: walk, getWorldTransform,
// getBounds, four transformed corners per entity, push, copy into WASM. Now that
// every backend shares one instance, those AABBs already live in the same linear
// memory, so the gather is a copy plus an index remap.
//
// The only thing that must not change is WHICH entity a point resolves to. The
// two index spaces differ (the transform store is depth-ordered for SIMD; the hit
// grid needs pre-order for its `idx > best` priority), so these tests compare the
// fused path against the JS path entity-for-entity over many probe points.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Scene, Entity } from '../../src/index';

const wasmPath = resolve(process.cwd(), 'src/wasm/vectojs_core.wasm');
const haveWasm = existsSync(wasmPath);
const wasmBytes = (): Uint8Array => {
  const b = readFileSync(wasmPath);
  const out = new Uint8Array(b.byteLength);
  out.set(b);
  return out;
};

class Box extends Entity {
  constructor(id: string, x: number, y: number, w: number, h: number) {
    super(id);
    this.x = x;
    this.y = y;
    this.width = w;
    this.height = h;
    this.interactive = true;
  }
  override getBounds() {
    return { x: 0, y: 0, width: this.width, height: this.height };
  }
  isPointInside(gx: number, gy: number): boolean {
    const p = this.worldToLocal(gx, gy);
    return !!p && p.x >= 0 && p.y >= 0 && p.x <= this.width && p.y <= this.height;
  }
  render(): void {}
}

/** An entity that opts out of culling, so it can only be resolved as boundless. */
class Boundless extends Entity {
  constructor(id: string, x: number, y: number, w: number, h: number) {
    super(id);
    this.x = x;
    this.y = y;
    this.width = w;
    this.height = h;
    this.interactive = true;
  }
  override getBounds() {
    return null;
  }
  isPointInside(gx: number, gy: number): boolean {
    const p = this.worldToLocal(gx, gy);
    return !!p && p.x >= 0 && p.y >= 0 && p.x <= this.width && p.y <= this.height;
  }
  render(): void {}
}

function makeScene(): Scene {
  (globalThis as { window?: unknown }).window = {
    innerWidth: 800,
    innerHeight: 600,
    devicePixelRatio: 1,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  // A permissive fake 2D context: Scene.resize() dereferences ctx.canvas, so a
  // null context (which the hit path itself would tolerate) breaks setup.
  const ctx = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'measureText') return (t: string) => ({ width: String(t).length * 8 });
        if (prop === 'canvas') return { width: 800, height: 600, style: {} };
        if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
        return () => {};
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
  HTMLCanvasElement.prototype.getContext = (() => ctx) as never;
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 600;
  const scene = new Scene(canvas, { disableWindowResize: true });
  scene.resize(800, 600);
  return scene;
}

/** A deliberately awkward tree: overlaps, nesting, rotation, scale, boundless. */
function populate(scene: Scene): void {
  for (let i = 0; i < 12; i++) {
    const outer = new Box(`outer${i}`, (i % 4) * 180 + 10, Math.floor(i / 4) * 150 + 10, 160, 130);
    // Overlapping children exercise the topmost-hit priority the index remap
    // has to preserve.
    outer.add(new Box(`inner${i}a`, 10, 10, 90, 70));
    outer.add(new Box(`inner${i}b`, 40, 30, 90, 70));
    if (i % 3 === 0) {
      const rotated = new Box(`rot${i}`, 20, 20, 60, 40);
      rotated.rotation = 0.4;
      rotated.scaleX = 1.3;
      rotated.scaleY = 0.8;
      outer.add(rotated);
    }
    if (i % 5 === 0) outer.add(new Boundless(`free${i}`, 5, 5, 50, 50));
    scene.root.add(outer);
  }
}

/** Probe a grid of points, returning the resolved entity id (or null) at each. */
function probe(scene: Scene): Array<string | null> {
  const out: Array<string | null> = [];
  for (let y = 5; y < 600; y += 23) {
    for (let x = 5; x < 800; x += 29) {
      out.push(scene.findEntityAt(x, y)?.id ?? null);
    }
  }
  return out;
}

describe.skipIf(!haveWasm)('fused hit-grid gather', () => {
  it('resolves exactly the same entity as the JS walk at every probe point', async () => {
    const jsScene = makeScene();
    populate(jsScene);
    jsScene.step(16.67);
    const jsResults = probe(jsScene);
    expect(jsScene.hitTestBackend).toBe('js');

    const wasmScene = makeScene();
    populate(wasmScene);
    // Transforms first: the fused gather needs the world matrices resident.
    expect(await wasmScene.enableWasmTransforms(wasmBytes())).toBe(true);
    expect(await wasmScene.enableWasmHitTest(wasmBytes())).toBe(true);
    wasmScene.step(16.67);
    const wasmResults = probe(wasmScene);

    expect(wasmScene.hitTestBackend).toBe('wasm');
    // The point of the whole change: same answers, different provenance.
    expect(wasmResults).toEqual(jsResults);
    // And at least some probes must actually hit something, or this proves
    // nothing.
    expect(wasmResults.filter((r) => r !== null).length).toBeGreaterThan(20);

    jsScene.destroy();
    wasmScene.destroy();
  });

  it('uses the fused gather when transforms are resident', async () => {
    const scene = makeScene();
    populate(scene);
    await scene.enableWasmTransforms(wasmBytes());
    await scene.enableWasmHitTest(wasmBytes());
    scene.step(16.67);

    scene.findEntityAt(100, 100);
    expect(scene.hitGatherPath).toBe('fused');
    scene.destroy();
  });

  it('falls back to the JS gather when transforms are not resident', async () => {
    const scene = makeScene();
    populate(scene);
    // Hit-test WASM without transform WASM: there is no resident AABB store to
    // read, so the JS gather must still run.
    await scene.enableWasmHitTest(wasmBytes());
    scene.step(16.67);

    scene.findEntityAt(100, 100);
    expect(scene.hitGatherPath).toBe('js');
    expect(scene.hitTestBackend).toBe('wasm');
    scene.destroy();
  });

  it('stays correct across a structural change', async () => {
    const scene = makeScene();
    populate(scene);
    await scene.enableWasmTransforms(wasmBytes());
    await scene.enableWasmHitTest(wasmBytes());
    scene.step(16.67);
    scene.findEntityAt(100, 100);

    // Adding entities invalidates every `_storeSlot`, which is exactly the case
    // that would silently read another entity's AABB if the identity check in
    // the fused gather were missing.
    const late = new Box('late', 300, 300, 120, 90);
    scene.root.add(late);
    scene.step(16.67);

    expect(scene.findEntityAt(360, 340)?.id).toBe('late');

    // Removing it must stop resolving there.
    scene.remove(late);
    scene.step(16.67);
    expect(scene.findEntityAt(360, 340)?.id).not.toBe('late');
    scene.destroy();
  });

  it('stays correct after entities move', async () => {
    const scene = makeScene();
    const mover = new Box('mover', 10, 10, 80, 60);
    scene.root.add(mover);
    await scene.enableWasmTransforms(wasmBytes());
    await scene.enableWasmHitTest(wasmBytes());
    scene.step(16.67);
    expect(scene.findEntityAt(40, 40)?.id).toBe('mover');

    // A pure transform change does not bump the structure version, so this pins
    // that the AABB pass is re-run rather than reusing the previous frame's.
    mover.x = 400;
    mover.y = 300;
    scene.step(16.67);

    expect(scene.findEntityAt(40, 40)).toBeNull();
    expect(scene.findEntityAt(430, 330)?.id).toBe('mover');
    scene.destroy();
  });

  it('still resolves boundless entities through the merge path', async () => {
    const scene = makeScene();
    const free = new Boundless('solo-free', 100, 100, 60, 60);
    scene.root.add(free);
    await scene.enableWasmTransforms(wasmBytes());
    await scene.enableWasmHitTest(wasmBytes());
    scene.step(16.67);

    // Boundless entities are not in the grid at all; they must still win by
    // pre-order index, which the remap has to keep intact.
    expect(scene.findEntityAt(130, 130)?.id).toBe('solo-free');
    scene.destroy();
  });
});
