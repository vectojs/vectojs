// @vitest-environment jsdom
// Stage 1 of the G1 hot-swap: prove that a store built from a LIVE scene tree,
// composed by the JS reference and the WASM kernel, yields world matrices
// bit-identical to what Scene.renderNode actually computed for the same scene.
// This validates the tree->store->kernel seam before any render-path rewrite.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Scene, Entity } from '../../src/index';
import { composeJS, readWorld } from '../../src/wasm/soa';
import { buildTreeStore } from '../../src/wasm/scene-store';
import { instantiateSync } from '../../src/wasm/backend';

HTMLCanvasElement.prototype.getContext = (() => null) as never;

// jsdom's import.meta.url is an http URL, so resolve from the package cwd instead.
const wasmPath = resolve(process.cwd(), 'src/wasm/vectojs_core.wasm');
const haveWasm = existsSync(wasmPath);

/** Scene.root is private; the store builder takes the tree root directly. */
const rootOf = (scene: Scene): Entity => (scene as unknown as { root: Entity }).root;

class Box extends Entity {
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

function setWindow(): void {
  (globalThis as { window?: unknown }).window = {
    innerWidth: 800,
    innerHeight: 600,
    devicePixelRatio: 1,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
}
function sceneWith(): Scene {
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
    canvas: null as unknown,
    globalAlpha: 1,
    fillStyle: '',
  };
  const canvas = {
    getContext: () => ctx,
    width: 400,
    height: 300,
    style: { width: '', height: '' },
  };
  ctx.canvas = canvas;
  const scene = new Scene(canvas as never);
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = () => 0;
  (scene as unknown as { isRunning: boolean }).isRunning = true;
  return scene;
}
function tick(scene: Scene): void {
  (scene as unknown as { loop: (t: number) => void }).loop(performance.now());
}

/** A small nested scene with rotation + non-uniform scale at several depths. */
function buildScene(): { scene: Scene; entities: Box[] } {
  setWindow();
  const scene = sceneWith();
  const a = new Box('a');
  a.x = 30;
  a.y = 40;
  a.rotation = 0.3;
  a.scaleX = 2;
  const b = new Box('b');
  b.x = 5;
  b.y = -7;
  b.rotation = -0.1;
  a.add(b);
  const c = new Box('c');
  c.x = 100;
  c.y = 10;
  c.rotation = 0.2;
  c.scaleY = 1.5;
  const d = new Box('d');
  d.x = 3;
  d.y = 3;
  d.rotation = 0.5;
  d.scaleX = 0.7;
  c.add(d);
  scene.add(a);
  scene.add(c);
  return { scene, entities: [a, b, c, d] };
}

describe('G1 Stage 1 — store from live tree matches the render walk', () => {
  it('composeJS over the built store equals renderNode world matrices, bit-for-bit', () => {
    const { scene, entities } = buildScene();
    tick(scene); // JS render populates each entity's world cache

    const { store, indexOf } = buildTreeStore(rootOf(scene));
    composeJS(store);

    for (const e of entities) {
      const rendered = e.getWorldTransform();
      const stored = readWorld(store, indexOf.get(e)!);
      expect(stored.a).toBe(rendered.a);
      expect(stored.b).toBe(rendered.b);
      expect(stored.c).toBe(rendered.c);
      expect(stored.d).toBe(rendered.d);
      expect(stored.e).toBe(rendered.e);
      expect(stored.f).toBe(rendered.f);
    }
  });

  it.skipIf(!haveWasm)('WASM kernel over the built store also equals the render walk', () => {
    const { scene, entities } = buildScene();
    tick(scene);

    const backend = instantiateSync(readFileSync(wasmPath))!;
    const { store, indexOf } = buildTreeStore(rootOf(scene));
    backend.compose(store, 'simd');

    for (const e of entities) {
      const rendered = e.getWorldTransform();
      const stored = readWorld(store, indexOf.get(e)!);
      expect(stored.a).toBe(rendered.a);
      expect(stored.b).toBe(rendered.b);
      expect(stored.c).toBe(rendered.c);
      expect(stored.d).toBe(rendered.d);
      expect(stored.e).toBe(rendered.e);
      expect(stored.f).toBe(rendered.f);
    }
  });

  it('maps every entity in the subtree to a distinct store index', () => {
    const { scene, entities } = buildScene();
    const { indexOf } = buildTreeStore(rootOf(scene));
    const indices = new Set<number>();
    for (const e of entities) {
      expect(indexOf.has(e)).toBe(true);
      indices.add(indexOf.get(e)!);
    }
    expect(indices.size).toBe(entities.length); // no collisions
    expect(indexOf.get(rootOf(scene))).toBe(0); // root at index 0
  });
});
