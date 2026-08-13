// @vitest-environment jsdom
// #468: a backend identity change (a runtime swap followed by re-enable) must
// invalidate the resident transform store. The new backend shares linear memory
// semantics with the old one but has never received `uploadRuns`; skipping the
// rebuild over an unchanged tree structure left its views zero-length and made
// the kernel reject every frame.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Scene, Entity } from '../../src/index';
import { loadCoreWasmRuntime } from '../../src/wasm/runtime';

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

describe.skipIf(!haveWasm)('transform backend after a runtime swap', () => {
  beforeEach(() => {
    clock = 0;
    setWindow();
  });

  it('rebuilds the resident store when the backend identity changes', async () => {
    const scene = sceneWith();
    const e = new Box();
    e.x = 5;
    scene.root.add(e);

    const ok = await scene.enableWasmTransforms(bytes());
    expect(ok).toBe(true);
    tickMs(scene, 16);
    expect(scene.accelerators.transform.activeThisFrame).toBe(true);
    expect(scene.accelerators.transform.reason).toBe('active');

    // Swap in a second runtime (a fresh instance whose transform backend has
    // never seen `uploadRuns`), then re-enable: this installs a NEW backend
    // object over an unchanged tree structure, so only a backend-identity
    // reset can trigger the store rebuild the new instance needs.
    const second = await loadCoreWasmRuntime(bytes());
    expect(second).not.toBeNull();
    scene.setWasmRuntime(second);
    const reenabled = await scene.enableWasmTransforms(bytes());
    expect(reenabled).toBe(true);

    tickMs(scene, 16);
    expect(scene.accelerators.transform.reason).toBe('active');
    expect(scene.accelerators.transform.activeThisFrame).toBe(true);
  });
});
