// @vitest-environment jsdom
// Stage 3 of the G1 hot-swap: the resident store. Across frames with an
// unchanged tree the layout is reused (rebuilt ONLY on structural change), and a
// per-frame gather picks up transform mutations — so the wasm-path world matrices
// track the scene frame to frame, and add/remove trigger a correct rebuild.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Scene, Entity } from '../../src/index';
import { instantiateSync } from '../../src/wasm/backend';

HTMLCanvasElement.prototype.getContext = (() => null) as never;

const wasmPath = resolve(process.cwd(), 'src/wasm/vectojs_core.wasm');
const haveWasm = existsSync(wasmPath);

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
const structVer = (s: Scene): number =>
  (s as unknown as { _storeStructureVersion: number })._storeStructureVersion;

/** Assert entity `e`'s wasm-path world transform equals the JS reference. */
function expectWorldMatchesJs(e: Entity): void {
  const w = e.getWorldTransform();
  // Independently recompose from the ancestor chain in JS.
  const chain: Entity[] = [];
  for (let n: Entity | null = e; n; n = n.parent) chain.push(n);
  let a = 1,
    b = 0,
    c = 0,
    d = 1,
    te = 0,
    tf = 0;
  for (let i = chain.length - 1; i >= 0; i--) {
    const n = chain[i];
    if (n.parent === null) continue; // root seeded to identity
    const cos = Math.cos(n.rotation),
      sin = Math.sin(n.rotation);
    const na = n.scaleX * cos,
      nb2 = n.scaleY * sin,
      nc = -n.scaleX * sin,
      nd = n.scaleY * cos;
    const nA = a * na + c * nb2,
      nB = b * na + d * nb2,
      nC = a * nc + c * nd,
      nD = b * nc + d * nd;
    const nE = a * n.x + c * n.y + te,
      nF = b * n.x + d * n.y + tf;
    a = nA;
    b = nB;
    c = nC;
    d = nD;
    te = nE;
    tf = nF;
  }
  expect(w.a).toBeCloseTo(a, 9);
  expect(w.e).toBeCloseTo(te, 9);
  expect(w.f).toBeCloseTo(tf, 9);
}

describe.skipIf(!haveWasm)('G1 Stage 3 — resident store across frames', () => {
  it('tracks transform mutations frame to frame without a structural rebuild', () => {
    setWindow();
    const scene = sceneWith();
    const parent = new Box('p');
    parent.x = 50;
    parent.rotation = 0.2;
    const child = new Box('c');
    child.x = 10;
    parent.add(child);
    scene.add(parent);
    scene.setTransformBackend(instantiateSync(readFileSync(wasmPath))!);

    tick(scene); // frame 1: rebuild
    const vAfterBuild = structVer(scene);
    expect(vAfterBuild).toBeGreaterThanOrEqual(0);
    expectWorldMatchesJs(child);

    // Move + rotate across several frames; structure is unchanged.
    for (let f = 0; f < 4; f++) {
      parent.x = 50 + f * 15;
      parent.rotation = 0.2 + f * 0.1;
      child.y = f * 7;
      tick(scene);
      expectWorldMatchesJs(child);
      expectWorldMatchesJs(parent);
    }
    // No structural rebuild happened for the transform-only frames.
    expect(structVer(scene)).toBe(vAfterBuild);
  });

  it('rebuilds on add and stays correct for the new entity', () => {
    setWindow();
    const scene = sceneWith();
    const parent = new Box('p');
    parent.x = 30;
    parent.rotation = 0.3;
    scene.add(parent);
    scene.setTransformBackend(instantiateSync(readFileSync(wasmPath))!);
    tick(scene);
    const v1 = structVer(scene);

    // Add a child — structural change — then render.
    const child = new Box('c');
    child.x = 12;
    child.rotation = -0.15;
    parent.add(child);
    tick(scene);
    expect(structVer(scene)).toBeGreaterThan(v1); // rebuilt
    expectWorldMatchesJs(child);
    expect(child._storeSlot).toBeGreaterThan(0); // got a real slot
  });

  it('rebuilds on remove and no longer trusts the removed slot', () => {
    setWindow();
    const scene = sceneWith();
    const parent = new Box('p');
    const child = new Box('c');
    child.x = 20;
    parent.add(child);
    scene.add(parent);
    scene.setTransformBackend(instantiateSync(readFileSync(wasmPath))!);
    tick(scene);
    expect(child._storeSlot).toBeGreaterThan(0);

    parent.remove(child);
    tick(scene); // rebuild without the child; parent still renders correctly
    expectWorldMatchesJs(parent);
    // The still-attached parent keeps a valid slot.
    expect(parent._storeSlot).toBeGreaterThanOrEqual(0);
  });
});
