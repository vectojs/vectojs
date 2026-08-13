// @vitest-environment jsdom
/**
 * The fused-gather AABB freshness flag across a TRANSIENT kernel rejection.
 *
 * `syncStore` marks `_aabbsFresh = false` only on a SUCCESSFUL kernel run
 * (world matrices changed). The rejection returns used to leave the flag
 * however the previous frame left it — so after a successful frame that ran
 * an ad-hoc hit query (`ensureAabbs` → fresh), a rejected successor frame
 * answered `ensureAabbs` from the flag alone and the fused gather read the
 * PREVIOUS frame's AABBs for a frame the render walk composed in JS. Both
 * rejection returns must clear the flag.
 */
import { describe, expect, it, vi } from 'vitest';
import { Scene, Entity } from '../../src/index';

HTMLCanvasElement.prototype.getContext = (() => null) as never;

class Box extends Entity {
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

function stubBackend() {
  const view = () => new Float64Array(64);
  const world = {
    wa: view(),
    wb: view(),
    wc: view(),
    wd: view(),
    we: view(),
    wf: view(),
    wo: view(),
  };
  for (let i = 0; i < 64; i++) {
    world.wa[i] = 1;
    world.wd[i] = 1;
    world.wo[i] = 1;
  }
  return {
    kernelOk: true,
    uploadRunsCalls: 0,
    runKernelCalls: 0,
    runAabbsCalls: 0,
    uploadRuns(): boolean {
      this.uploadRunsCalls++;
      return true;
    },
    runKernel(): number {
      this.runKernelCalls++;
      return this.kernelOk ? 0 : 1; // WASM_STATUS.OK : non-zero rejection
    },
    runAabbs(): boolean {
      this.runAabbsCalls++;
      return true;
    },
    revalidateViews(): void {},
    inputView() {
      return {
        x: view(),
        y: view(),
        sx: view(),
        sy: view(),
        cos: view(),
        sin: view(),
        opacity: view(),
      };
    },
    worldView() {
      return world;
    },
    boundsView() {
      return { bx: view(), by: view(), bw: view(), bh: view() };
    },
  };
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

let clock = 0;
function tick(scene: Scene): void {
  clock += 100; // beyond any frame-cap interval, so every tick renders
  scene.markDirty();
  (scene as unknown as { loop: (t: number) => void }).loop(clock);
}

interface Facade {
  ensureAabbs: () => boolean;
}

describe('WASM transform backend: AABB freshness across a transient kernel rejection', () => {
  it('re-runs the AABB pass after a rejection instead of trusting the stale flag', () => {
    setWindow();
    const scene = sceneWith();
    const backend = stubBackend();
    scene.setTransformBackend(backend as never);
    expect(scene.transformBackend).toBe('wasm');
    scene.add(new Box('b'));

    // Frame 1: kernel OK, then an ad-hoc hit query computes + marks AABBs fresh.
    tick(scene);
    const facade = (scene as unknown as { _wasmBackend: Facade })._wasmBackend;
    expect(facade.ensureAabbs()).toBe(true);
    expect(backend.runAabbsCalls).toBe(1);

    // Frame 2: the kernel transiently rejects; the render walk composes in JS
    // while the store still holds frame-1 matrices.
    backend.kernelOk = false;
    tick(scene);

    // The fresh flag must NOT survive the rejection: the next query has to run
    // the pass again rather than answer from frame-1 AABBs.
    expect(facade.ensureAabbs()).toBe(true);
    expect(backend.runAabbsCalls).toBe(2);
  });

  it('also clears the flag on the uploadRuns rejection return', () => {
    setWindow();
    const scene = sceneWith();
    const backend = stubBackend();
    scene.setTransformBackend(backend as never);
    scene.add(new Box('b'));

    tick(scene);
    const facade = (scene as unknown as { _wasmBackend: Facade })._wasmBackend;
    expect(facade.ensureAabbs()).toBe(true);
    expect(backend.runAabbsCalls).toBe(1);

    // A structure change makes the next syncStore rebuild; rejecting the
    // upload takes the OTHER rejection return (before any kernel runs).
    scene.add(new Box('b2'));
    backend.uploadRuns = () => {
      backend.uploadRunsCalls++;
      return false;
    };
    tick(scene);

    expect(facade.ensureAabbs()).toBe(true);
    expect(backend.runAabbsCalls).toBe(2);
  });
});
