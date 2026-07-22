// @vitest-environment jsdom
// Stage 4 of the G1 hot-swap: edge cases. The resident WASM store covers only
// the main tree (Scene.root); everything else must fall back to the JS
// composition, and the store must stay correct across structural churn. These
// tests lock in the guarantees that let WASM stay on by default:
//   - overlays (a separate root, never in the store) render correctly;
//   - toSVG()/any secondary renderer uses the JS path and never clobbers the
//     main render's world cache;
//   - the store grows and rebuilds correctly on bulk add / reparent / remove;
//   - clearing the backend mid-session reverts to a correct JS path even though
//     entities still carry stale `_storeSlot` values;
//   - a detached entity's getWorldTransform() never reads a stale slot;
//   - the passive-node update() skip never freezes an animation (no-freeze).
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Scene, Entity } from '../../src/index';
import { instantiateSync } from '../../src/wasm/backend';

HTMLCanvasElement.prototype.getContext = (() => null) as never;

const wasmPath = resolve(process.cwd(), 'src/wasm/vectojs_core.wasm');
const haveWasm = existsSync(wasmPath);
const bytes = () => readFileSync(wasmPath);

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
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    canvas: null as unknown,
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
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

let clock = 1000;
function tick(scene: Scene): void {
  clock += 100; // > any frame-cap interval, so every tick renders
  (scene as unknown as { loop: (t: number) => void }).loop(clock);
}
function enableWasm(scene: Scene): void {
  scene.setTransformBackend(instantiateSync(bytes())!);
  expect(scene.transformBackend).toBe('wasm');
}

/** Recompose entity `e`'s world transform from its ancestor chain in plain JS. */
function jsWorld(e: Entity): { a: number; e: number; f: number } {
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
      nb = n.scaleY * sin,
      nc = -n.scaleX * sin,
      nd = n.scaleY * cos;
    const nA = a * na + c * nb,
      nB = b * na + d * nb,
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
  return { a, e: te, f: tf };
}
function expectMatches(e: Entity): void {
  const w = e.getWorldTransform();
  const ref = jsWorld(e);
  expect(w.a).toBeCloseTo(ref.a, 9);
  expect(w.e).toBeCloseTo(ref.e, 9);
  expect(w.f).toBeCloseTo(ref.f, 9);
}

describe.skipIf(!haveWasm)('G1 Stage 4 — edge cases', () => {
  it('renders overlays correctly in wasm mode (overlays are never in the store)', () => {
    setWindow();
    const scene = sceneWith();
    const main = new Box('main');
    main.x = 40;
    main.rotation = 0.3;
    scene.add(main);
    // Overlay: lives under overlayRoot, not Scene.root — the store never sees it.
    const overlay = new Box('overlay');
    overlay.x = 90;
    overlay.rotation = -0.4;
    overlay.scaleX = 1.4;
    scene.showOverlay(overlay);

    enableWasm(scene);
    tick(scene);

    // Main entity comes from the store; the overlay from the JS fallback. Both
    // must be correct, and the overlay must NOT have picked up a (wrong) slot.
    expectMatches(main);
    expectMatches(overlay);
    expect(overlay._storeSlot).toBe(-1);
  });

  it('toSVG() uses the JS path and does not clobber the main render world cache', () => {
    setWindow();
    const scene = sceneWith();
    const e = new Box('e');
    e.x = 55;
    e.y = 22;
    e.rotation = 0.5;
    e.scaleX = 1.3;
    scene.add(e);

    enableWasm(scene);
    tick(scene); // authoritative main frame writes e's world cache
    const cached = e.getWorldTransform();

    // A secondary renderer (SVGRenderer) must not bump currentFrame or overwrite
    // the cache — otherwise ad-hoc getWorldTransform() callers would read a
    // matrix from the wrong renderer.
    expect(() => scene.toSVG()).not.toThrow();
    const after = e.getWorldTransform();
    expect(after.a).toBe(cached.a);
    expect(after.e).toBe(cached.e);
    expect(after.f).toBe(cached.f);
    expectMatches(e);
  });

  it('grows and rebuilds the store on bulk add, staying correct for deep new nodes', () => {
    setWindow();
    const scene = sceneWith();
    const root = new Box('r');
    root.x = 10;
    root.rotation = 0.1;
    scene.add(root);

    enableWasm(scene);
    tick(scene); // small store

    // Add a deep chain far past the initial capacity — a structural change, so
    // the next wasm-mode frame rebuilds the store and re-sizes wasm memory.
    let parent = root;
    let deepest = root;
    for (let i = 0; i < 400; i++) {
      const c = new Box(`c${i}`);
      c.x = 2;
      c.y = 1;
      c.rotation = 0.01 * i;
      c.scaleX = 1.001;
      parent.add(c);
      parent = c;
      deepest = c;
    }
    tick(scene);
    expectMatches(deepest);
    expect(deepest._storeSlot).toBeGreaterThan(0);
  });

  it('stays correct after a reparent (topology change → rebuild)', () => {
    setWindow();
    const scene = sceneWith();
    const a = new Box('a');
    a.x = 100;
    a.rotation = 0.6;
    const b = new Box('b');
    b.x = -30;
    b.rotation = 0.2;
    const child = new Box('child');
    child.x = 15;
    child.y = 5;
    a.add(child);
    scene.add(a);
    scene.add(b);

    enableWasm(scene);
    tick(scene);
    expectMatches(child);

    // Move child from a → b. Entity.remove/add bump the structure version.
    a.remove(child);
    b.add(child);
    tick(scene);
    expectMatches(child); // now composed under b, not a
  });

  it('reverts to a correct JS path when the backend is cleared mid-session', () => {
    setWindow();
    const scene = sceneWith();
    const p = new Box('p');
    p.x = 70;
    p.rotation = 0.35;
    const c = new Box('c');
    c.x = 12;
    p.add(c);
    scene.add(p);

    enableWasm(scene);
    tick(scene);
    expect(c._storeSlot).toBeGreaterThan(0); // c carries a real slot now

    // Clear the backend. c still holds its (now meaningless) _storeSlot, but the
    // render walk must ignore it (wasmWorld === null) and compose in JS.
    scene.setTransformBackend(null);
    expect(scene.transformBackend).toBe('js');
    p.x = 200; // move it so a stale-slot read would be visibly wrong
    tick(scene);
    expectMatches(c);
  });

  it('a detached entity getWorldTransform() never reads a stale slot', () => {
    setWindow();
    const scene = sceneWith();
    const p = new Box('p');
    p.x = 50;
    const c = new Box('c');
    c.x = 20;
    c.rotation = 0.4;
    p.add(c);
    scene.add(p);

    enableWasm(scene);
    tick(scene);
    const slot = c._storeSlot;
    expect(slot).toBeGreaterThan(0);

    // Detach c. It keeps its stale slot, but getWorldTransform() walks the
    // ancestor chain (frame cache misses), so it reflects c's own local
    // transform — never a value read out of the old store slot.
    p.remove(c);
    const w = c.getWorldTransform();
    expect(w.e).toBeCloseTo(20, 9); // c.x, composed from identity (no parent)
    expect(w.f).toBeCloseTo(0, 9);
  });

  it('never freezes an animation started after WASM is enabled (no-freeze)', () => {
    setWindow();
    const scene = sceneWith();
    const mover = new Box('mover');
    mover.x = 0;
    scene.add(mover);

    enableWasm(scene);
    tick(scene); // passive frame: mover.update() is skipped, x stays 0
    expect(mover.x).toBe(0);

    // Start a tween AFTER the hot-swap. The passive-skip must notice the newly
    // pending animation and tick it — the whole point of checking live state.
    mover.animate({ x: 100 }, 100);
    tick(scene); // first update seeds startTime
    tick(scene); // advances well past the 100ms duration → snaps to target
    expect(mover.x).toBeGreaterThan(0);
    expect(mover.x).toBeCloseTo(100, 5);
    // And its world transform (from the store) reflects the animated position.
    expectMatches(mover);
  });
});
