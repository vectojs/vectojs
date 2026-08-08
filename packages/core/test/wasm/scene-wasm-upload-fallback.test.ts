// @vitest-environment jsdom
/**
 * Permanent JS fallback after repeated `uploadRuns` rejections.
 *
 * When the crate rejects the run count, `_syncWasmStore` deliberately leaves
 * `_storeStructureVersion` stale so the next frame retries the rebuild — correct
 * while the cause might be transient, because the published run table still
 * describes the PREVIOUS topology and composing against it would lay this frame
 * out along last frame's parent links.
 *
 * If the rejection is persistent (a topology over the crate's hard run cap) that
 * retry never succeeds, so the scene paid a full O(n) `buildTreeStore` plus a
 * run-table upload every frame, forever, with no escape to the JS path. After
 * three consecutive rejections the backend mode now flips to `'js'` for the
 * scene's lifetime. Threshold and re-enable policy: carryctx DEC-0014.
 *
 * Uses a stub backend rather than the real crate: the rejection is reachable
 * only with a topology over the hard cap, and the `.wasm` is gitignored (built in
 * CI), so a real-backend test here would be skipped exactly where it matters.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scene, Entity } from '../../src/index';

HTMLCanvasElement.prototype.getContext = (() => null) as never;

class Box extends Entity {
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

/**
 * Minimal stand-in for `WasmTransformBackend`, covering only what
 * `_syncWasmStore` and the render walk touch. `uploadRuns` is driven by
 * `reject`, so a test can make the rejection persistent or intermittent.
 */
function stubBackend(capacity = 64) {
  const view = () => new Float64Array(capacity);
  const world = {
    wa: view(),
    wb: view(),
    wc: view(),
    wd: view(),
    we: view(),
    wf: view(),
    wo: view(),
  };
  // Identity, so a wasm-path frame that does read these renders sanely.
  for (let i = 0; i < capacity; i++) {
    world.wa[i] = 1;
    world.wd[i] = 1;
    world.wo[i] = 1;
  }
  return {
    reject: true,
    uploadRunsCalls: 0,
    runKernelCalls: 0,
    uploadRuns(): boolean {
      this.uploadRunsCalls++;
      return !this.reject;
    },
    runKernel(): number {
      this.runKernelCalls++;
      return 0; // WASM_STATUS.OK
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

type Stub = ReturnType<typeof stubBackend>;

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

/** Install the stub and confirm the scene really is on the wasm path first. */
function install(scene: Scene, backend: Stub): void {
  scene.setTransformBackend(backend as never);
  expect(scene.transformBackend).toBe('wasm');
}

function rejections(scene: Scene): number {
  return (scene as unknown as { _wasmUploadRejections: number })._wasmUploadRejections;
}

describe('WASM transform backend: permanent JS fallback on persistent uploadRuns rejection', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clock = 0;
    setWindow();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('flips to JS after exactly 3 consecutive rejections and stops rebuilding', () => {
    const scene = sceneWith();
    scene.root.add(new Box());
    const backend = stubBackend();
    install(scene, backend);

    tick(scene);
    expect(scene.transformBackend).toBe('wasm'); // one strike is not enough
    expect(backend.uploadRunsCalls).toBe(1);

    tick(scene);
    expect(scene.transformBackend).toBe('wasm');
    expect(backend.uploadRunsCalls).toBe(2);

    tick(scene);
    expect(scene.transformBackend).toBe('js');
    expect(backend.uploadRunsCalls).toBe(3);

    // The point of the fallback: no further O(n) rebuild + upload per frame.
    tick(scene);
    tick(scene);
    expect(backend.uploadRunsCalls).toBe(3);
  });

  it('warns once with the run and entity counts, not once per frame', () => {
    const scene = sceneWith();
    for (let i = 0; i < 3; i++) scene.root.add(new Box());
    install(scene, stubBackend());

    for (let i = 0; i < 6; i++) tick(scene);

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('3 consecutive');
    expect(message).toContain('runs for');
    // Diagnosable: the message has to say how big the topology was.
    expect(message).toMatch(/\d+ runs for \d+ entities/);
  });

  it('resets the streak on a success, so an intermittent rejection keeps WASM', () => {
    const scene = sceneWith();
    scene.root.add(new Box());
    const backend = stubBackend();
    install(scene, backend);

    // Two strikes...
    tick(scene);
    tick(scene);
    expect(rejections(scene)).toBe(2);

    // ...then a success clears the count.
    backend.reject = false;
    tick(scene);
    expect(rejections(scene)).toBe(0);
    expect(scene.transformBackend).toBe('wasm');

    // Two more strikes must therefore NOT reach the limit.
    backend.reject = true;
    scene.root.add(new Box()); // bump the structure version so a rebuild is attempted
    tick(scene);
    scene.root.add(new Box());
    tick(scene);
    expect(scene.transformBackend).toBe('wasm');
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps rendering correct geometry on the JS path after the fallback', () => {
    const scene = sceneWith();
    const parent = new Box();
    const child = new Box();
    parent.x = 30;
    child.x = 7;
    parent.add(child);
    scene.root.add(parent);
    install(scene, stubBackend());

    for (let i = 0; i < 4; i++) tick(scene);
    expect(scene.transformBackend).toBe('js');

    // The whole reason JS is the permanent fallback: world transforms must still
    // be right once the accelerator is gone.
    expect(child.getWorldTransform().e).toBe(37);
  });

  it('reports the rejection through accelerators without claiming it ran', () => {
    const scene = sceneWith();
    scene.root.add(new Box());
    install(scene, stubBackend());

    for (let i = 0; i < 3; i++) tick(scene);

    const transform = scene.accelerators.transform;
    expect(transform.reason).toBe('rejected');
    expect(transform.activeThisFrame).toBe(false);
    expect(transform.path).toBe('js');
    // No longer available: the backend mode is 'js' now, permanently.
    expect(transform.available).toBe(false);
  });

  it('re-enables on an explicit setTransformBackend() and clears the streak', () => {
    const scene = sceneWith();
    scene.root.add(new Box());
    const backend = stubBackend();
    install(scene, backend);

    for (let i = 0; i < 3; i++) tick(scene);
    expect(scene.transformBackend).toBe('js');

    // The documented way back (DEC-0014). The streak must clear with it, or the
    // very next rejection would trip the limit immediately.
    backend.reject = false;
    scene.setTransformBackend(backend as never);
    expect(scene.transformBackend).toBe('wasm');
    expect(rejections(scene)).toBe(0);

    tick(scene);
    expect(scene.transformBackend).toBe('wasm');
  });

  it('never disables a backend whose uploads all succeed', () => {
    // The over-rejection direction: the counter must not fire on a healthy scene.
    const scene = sceneWith();
    scene.root.add(new Box());
    const backend = stubBackend();
    backend.reject = false;
    install(scene, backend);

    for (let i = 0; i < 5; i++) {
      scene.root.add(new Box()); // force a rebuild every frame
      tick(scene);
    }

    expect(scene.transformBackend).toBe('wasm');
    expect(rejections(scene)).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });
});
