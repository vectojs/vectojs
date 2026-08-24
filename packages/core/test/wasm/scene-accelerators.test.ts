// @vitest-environment jsdom
// Per-frame accelerator reporting: Scene.accelerators must say what actually ran
// this frame and WHY the rest did not.
//
// The motivating defect is a reporting one. `transformBackend`/`animBackend`
// report only that a backend is INSTALLED, so a scene holding four WASM backends
// and running every frame in JS reported itself as fully accelerated. These tests
// pin the distinction between `available` and `activeThisFrame`, and pin each
// reason code to the condition that actually produces it — a reason nothing can
// produce is worse than no reason at all.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Scene, Entity } from '../../src/index';
import { instantiateSync as animInstantiate } from '../../src/wasm/anim-backend';

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

function sceneWith(w = 400, h = 300): Scene {
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
    width: w,
    height: h,
    style: { width: '', height: '' },
  };
  ctx.canvas = canvas;
  const scene = new Scene(canvas as never);
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = () => 0;
  (scene as unknown as { isRunning: boolean }).isRunning = true;
  scene.maxFPS = 0;
  return scene;
}

let clock = 0;
function tickMs(scene: Scene, dtMs: number): void {
  clock += dtMs;
  (scene as unknown as { loop: (t: number) => void }).loop(clock);
}

describe.skipIf(!haveWasm)('Scene.accelerators — per-frame backend + reason', () => {
  beforeEach(() => {
    clock = 0;
    setWindow();
  });

  it('reports every accelerator as not-installed on a plain scene', () => {
    const scene = sceneWith();
    scene.root.add(new Box());
    tickMs(scene, 16);

    const a = scene.accelerators;
    expect(a.transform.available).toBe(false);
    expect(a.transform.reason).toBe('not-installed');
    expect(a.transform.activeThisFrame).toBe(false);
    expect(a.transform.path).toBe('js');

    expect(a.animation.available).toBe(false);
    expect(a.hitTest.available).toBe(false);
    expect(a.hitTest.reason).toBe('not-installed');

    // No particle entities in the tree, so nothing declined — that is distinct
    // from a backend being absent.
    expect(a.particle.reason).toBe('not-applicable');
    expect(a.particle.path).toBe('none');
  });

  it('separates an INSTALLED animation backend from an ACTIVE one', async () => {
    const scene = sceneWith();
    const e = new Box();
    scene.root.add(e);
    scene.setAnimBackend(animInstantiate(bytes())!);
    // Gate far above one driver: installed, and deliberately not used.
    scene.animGate = { spring: 1000, tween: 1000, mixed: 1000 };
    e.springTo({ x: 50 });
    tickMs(scene, 16);

    const a = scene.accelerators;
    // This is the exact confusion the report exists to remove: the old
    // `animBackend` getter says 'wasm' here while every driver ticked in JS.
    expect(scene.animBackend).toBe('wasm');
    expect(a.animation.available).toBe(true);
    expect(a.animation.activeThisFrame).toBe(false);
    expect(a.animation.reason).toBe('below-gate');
    expect(a.animation.path).toBe('js');
  });

  it('reports animation active once the gate opens', () => {
    const scene = sceneWith();
    scene.setAnimBackend(animInstantiate(bytes())!);
    scene.animGate = { spring: 2, tween: 2, mixed: 2 };
    for (let i = 0; i < 6; i++) {
      const e = new Box();
      scene.root.add(e);
      e.springTo({ x: 50 });
    }
    tickMs(scene, 16);

    const a = scene.accelerators;
    expect(a.animation.activeThisFrame).toBe(true);
    expect(a.animation.reason).toBe('active');
    expect(a.animation.path).toBe('wasm');
    // The existing single-purpose getter must keep agreeing with the report.
    expect(scene.animBatchedLastFrame).toBe(true);
  });

  it('reports not-applicable when no drivers are in flight', () => {
    const scene = sceneWith();
    scene.setAnimBackend(animInstantiate(bytes())!);
    scene.root.add(new Box());
    tickMs(scene, 16);

    const a = scene.accelerators;
    expect(a.animation.available).toBe(true);
    expect(a.animation.reason).toBe('not-applicable');
    expect(a.animation.activeThisFrame).toBe(false);
  });

  it('reports the transform accelerator active once installed', async () => {
    const scene = sceneWith();
    scene.root.add(new Box());
    const ok = await scene.enableWasmTransforms(bytes());
    expect(ok).toBe(true);
    tickMs(scene, 16);

    const a = scene.accelerators;
    expect(a.transform.available).toBe(true);
    expect(a.transform.activeThisFrame).toBe(true);
    expect(a.transform.reason).toBe('active');
    expect(a.transform.path).toBe('wasm');
  });

  it('reports the hit-test accelerator only after a query builds the grid', async () => {
    const scene = sceneWith();
    const e = new Box();
    e.x = 10;
    e.y = 10;
    e.interactive = true;
    scene.root.add(e);
    await scene.enableWasmHitTest(bytes());
    tickMs(scene, 16);

    // Installed, but the grid is lazy: rendering a frame does not build it.
    let a = scene.accelerators;
    expect(a.hitTest.available).toBe(true);
    expect(a.hitTest.reason).toBe('not-applicable');
    expect(a.hitTest.activeThisFrame).toBe(false);

    scene.findEntityAt(12, 12);
    a = scene.accelerators;
    expect(a.hitTest.activeThisFrame).toBe(true);
    expect(a.hitTest.reason).toBe('active');
    expect(a.hitTest.path).toMatch(/^wasm/);
  });

  it('keeps the four accelerators independent', async () => {
    const scene = sceneWith();
    scene.root.add(new Box());
    await scene.enableWasmTransforms(bytes());
    tickMs(scene, 16);

    const a = scene.accelerators;
    // Enabling one must not imply the others: a scene composing transforms in
    // WASM while ticking drivers in JS is the normal case, not an anomaly.
    expect(a.transform.activeThisFrame).toBe(true);
    expect(a.animation.available).toBe(false);
    expect(a.hitTest.available).toBe(false);
  });

  it('does not let a secondary renderer overwrite the main frame verdict', async () => {
    const scene = sceneWith();
    scene.root.add(new Box());
    await scene.enableWasmTransforms(bytes());
    tickMs(scene, 16);
    expect(scene.accelerators.transform.reason).toBe('active');

    // Render through a renderer that is NOT scene.renderer. The report describes
    // the scene's frame, so an off-screen/export pass must leave it alone.
    //
    // A Proxy stub rather than a hand-listed one: IRenderer has ~30 methods and
    // the render walk calls whichever the tree needs, so enumerating them by hand
    // makes this test fail for reasons unrelated to what it checks.
    const other = new Proxy({ kind: 'canvas' } as Record<string, unknown>, {
      get: (target, prop) => (prop in target ? target[prop as string] : () => undefined),
    });
    (scene as unknown as { render: (r: unknown) => void }).render(other);
    expect(scene.accelerators.transform.reason).toBe('active');
  });
});

describe.skipIf(!haveWasm)('rejected is reachable, not decorative', () => {
  beforeEach(() => {
    clock = 0;
    setWindow();
  });

  it('reports springs-rejected when the spring kernel refuses the count', () => {
    const scene = sceneWith();
    scene.setAnimBackend(animInstantiate(bytes())!);
    scene.animGate = { spring: 2, tween: 2, mixed: 2 };
    for (let i = 0; i < 6; i++) {
      const e = new Box();
      scene.root.add(e);
      e.springTo({ x: 50 });
    }

    // Force the kernel to decline: report a capacity far below the pack the
    // Scene is about to submit. This is what a sizing bug upstream looks like.
    const backend = (scene as unknown as { _animWasm: { stepSprings: unknown } })._animWasm;
    backend.stepSprings = () => false;

    tickMs(scene, 16);
    const a = scene.accelerators;
    // Springs-only frame: the kind that declined is named, not a blanket
    // fully-JS 'rejected' (that verdict is reserved for both kinds declining).
    expect(a.animation.reason).toBe('springs-rejected');
    // The JS fallback ticked the springs, so nothing ran through WASM.
    expect(a.animation.activeThisFrame).toBe(false);
    expect(a.animation.path).toBe('js');
    // A rejected batch must not also claim it ran.
    expect(scene.animBatchedLastFrame).toBe(false);
  });

  it('reports rejected only when BOTH anim kernels refuse, and keeps partial truth', () => {
    const scene = sceneWith();
    scene.setAnimBackend(animInstantiate(bytes())!);
    scene.animGate = { spring: 2, tween: 2, mixed: 2 };
    for (let i = 0; i < 6; i++) {
      const e = new Box();
      scene.root.add(e);
      // Mixed workload so both kernels get a pack this frame.
      if (i % 2 === 0) e.springTo({ x: 50 });
      else e.animateTo({ x: 50 }, { duration: 100, easing: 'linear' });
    }

    const backend = (scene as unknown as { _animWasm: Record<string, unknown> })._animWasm;
    // Only tweens decline: springs still step via WASM, so the frame is a
    // partial acceleration — active with the failing kind named.
    backend.stepTweens = () => false;
    tickMs(scene, 16);
    let a = scene.accelerators;
    expect(a.animation.reason).toBe('tweens-rejected');
    expect(a.animation.activeThisFrame).toBe(true);
    expect(a.animation.path).toBe('wasm');

    // Both decline: fully-JS frame, the plain fault verdict.
    backend.stepSprings = () => false;
    tickMs(scene, 16);
    a = scene.accelerators;
    expect(a.animation.reason).toBe('rejected');
    expect(a.animation.activeThisFrame).toBe(false);
    expect(a.animation.path).toBe('js');
    expect(scene.animBatchedLastFrame).toBe(false);
  });

  it('reports rejected when the transform kernel refuses, and does not render stale matrices', async () => {
    const scene = sceneWith();
    const e = new Box();
    e.x = 5;
    scene.root.add(e);
    await scene.enableWasmTransforms(bytes());
    tickMs(scene, 16);
    expect(scene.accelerators.transform.reason).toBe('active');

    // A rejecting kernel leaves the world views holding the PREVIOUS frame's
    // matrices. Before this change `_syncWasmStore` discarded the status and
    // returned those stale views, so the render walk drew last frame's geometry
    // as if it were current.
    const backend = (scene as unknown as { _wasm: { runKernel: unknown } })._wasm;
    backend.runKernel = () => 1; // WASM_STATUS.CAPACITY

    tickMs(scene, 16);
    const a = scene.accelerators;
    expect(a.transform.reason).toBe('rejected');
    expect(a.transform.activeThisFrame).toBe(false);
    // Still installed — this is a per-frame fault, not an uninstall.
    expect(a.transform.available).toBe(true);
    expect(a.transform.path).toBe('js');
  });
});
