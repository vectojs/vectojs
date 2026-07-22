// @vitest-environment jsdom
// Stage 2 of the G1 hot-swap: render the SAME scene on the JS path and the WASM
// path and assert they are indistinguishable — identical draw-op sequences
// (cull decisions included, since culling reads the world matrix) and identical
// getWorldTransform() for every entity. This gates the render-path rewrite: a
// WASM bug shows up as a divergence here, never as a silent wrong pixel.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Scene, Entity, type IRenderer } from '../../src/index';
import { instantiateSync } from '../../src/wasm/backend';

HTMLCanvasElement.prototype.getContext = (() => null) as never;

const wasmPath = resolve(process.cwd(), 'src/wasm/vectojs_core.wasm');
const haveWasm = existsSync(wasmPath);

type Call = { op: string; style?: string; alpha?: number };

function recorderCtx(): { ctx: Record<string, unknown>; calls: Call[] } {
  const calls: Call[] = [];
  let fillStyle = '';
  let alpha = 1;
  const ctx: Record<string, unknown> = {
    scale: vi.fn(),
    setTransform: vi.fn(),
    clearRect: () => calls.push({ op: 'clearRect' }),
    save: () => calls.push({ op: 'save' }),
    restore: () => calls.push({ op: 'restore' }),
    translate: vi.fn(),
    rotate: vi.fn(),
    beginPath: () => calls.push({ op: 'beginPath' }),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: () => calls.push({ op: 'arc' }),
    roundRect: vi.fn(),
    fill: () => calls.push({ op: 'fill', style: fillStyle, alpha }),
    stroke: () => calls.push({ op: 'stroke', style: fillStyle }),
    fillText: () => calls.push({ op: 'fillText', style: fillStyle }),
    clip: vi.fn(),
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(v: string) {
      fillStyle = v;
    },
    get globalAlpha() {
      return alpha;
    },
    set globalAlpha(v: number) {
      alpha = v;
    },
    set strokeStyle(_v: string) {},
    set lineWidth(_v: number) {},
    set font(_v: string) {},
    canvas: null,
  };
  return { ctx, calls };
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

/** A dot that draws a colored circle and reports bounds (so it can be culled). */
class Dot extends Entity {
  color: string;
  constructor(id: string, color: string) {
    super(id);
    this.color = color;
    this.width = 10;
    this.height = 10;
  }
  isPointInside(): boolean {
    return false;
  }
  getBounds(): { x: number; y: number; width: number; height: number } {
    return { x: -5, y: -5, width: 10, height: 10 };
  }
  render(r: IRenderer): void {
    r.beginPath();
    r.arc(0, 0, 5, 0, Math.PI * 2);
    r.fill(this.color);
  }
}

function buildScene(
  calls: Call[],
  ctx: Record<string, unknown>,
): { scene: Scene; entities: Dot[] } {
  setWindow();
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

  const parent = new Dot('parent', '#38bdf8');
  parent.x = 120;
  parent.y = 80;
  parent.rotation = 0.4;
  parent.scaleX = 1.5;
  const child = new Dot('child', '#f0f');
  child.x = 20;
  child.y = 10;
  child.rotation = -0.2;
  parent.add(child);
  const onScreen = new Dot('on', '#0f0');
  onScreen.x = 200;
  onScreen.y = 150;
  onScreen.rotation = 0.9;
  // Far off the 400x300 viewport → must be culled in BOTH modes.
  const offScreen = new Dot('off', '#ff0');
  offScreen.x = 5000;
  offScreen.y = 5000;
  scene.add(parent);
  scene.add(onScreen);
  scene.add(offScreen);
  calls.length = 0; // ignore construction-time ops (there are none, but be safe)
  return { scene, entities: [parent, child, onScreen, offScreen] };
}

function tick(scene: Scene): void {
  (scene as unknown as { loop: (t: number) => void }).loop(performance.now());
}
function worldOf(entities: Dot[]) {
  return entities.map((e) => e.getWorldTransform());
}

describe.skipIf(!haveWasm)('G1 Stage 2 — WASM render path matches the JS render path', () => {
  it('produces an identical draw-op sequence and identical world transforms', () => {
    const { ctx, calls } = recorderCtx();
    const { scene, entities } = buildScene(calls, ctx);

    // JS path.
    tick(scene);
    const jsCalls = calls.slice();
    const jsWorld = worldOf(entities);

    // Swap to WASM and render the same scene again.
    const backend = instantiateSync(readFileSync(wasmPath))!;
    scene.setTransformBackend(backend);
    expect(scene.transformBackend).toBe('wasm');
    calls.length = 0;
    tick(scene);
    const wasmCalls = calls.slice();
    const wasmWorld = worldOf(entities);

    // Same draw ops, in the same order, with the same styles/alpha — this only
    // holds if cull decisions (which read the world matrix) also match.
    expect(wasmCalls).toEqual(jsCalls);
    // At least one fill drew (the scene is not trivially empty).
    expect(jsCalls.some((c) => c.op === 'fill')).toBe(true);

    // Every entity's world matrix is bit-identical between the two paths.
    for (let i = 0; i < entities.length; i++) {
      expect(wasmWorld[i].a).toBe(jsWorld[i].a);
      expect(wasmWorld[i].b).toBe(jsWorld[i].b);
      expect(wasmWorld[i].c).toBe(jsWorld[i].c);
      expect(wasmWorld[i].d).toBe(jsWorld[i].d);
      expect(wasmWorld[i].e).toBe(jsWorld[i].e);
      expect(wasmWorld[i].f).toBe(jsWorld[i].f);
    }
  });

  it('reverts to the JS path when the backend is cleared', () => {
    const { ctx, calls } = recorderCtx();
    const { scene } = buildScene(calls, ctx);
    const backend = instantiateSync(readFileSync(wasmPath))!;
    scene.setTransformBackend(backend);
    expect(scene.transformBackend).toBe('wasm');
    scene.setTransformBackend(null);
    expect(scene.transformBackend).toBe('js');
    expect(() => tick(scene)).not.toThrow();
  });
});

describe('G1 Stage 2 — hot-swap lifecycle', () => {
  it('new Scene() starts on the JS path', () => {
    const { ctx, calls } = recorderCtx();
    const { scene } = buildScene(calls, ctx);
    expect(scene.transformBackend).toBe('js');
    expect(() => tick(scene)).not.toThrow();
  });

  it.skipIf(!haveWasm)('enableWasmTransforms hot-swaps on success', async () => {
    const { ctx, calls } = recorderCtx();
    const { scene } = buildScene(calls, ctx);
    const ok = await scene.enableWasmTransforms(readFileSync(wasmPath));
    expect(ok).toBe(true);
    expect(scene.transformBackend).toBe('wasm');
  });

  it('enableWasmTransforms stays on JS when the bytes are not a valid module', async () => {
    const { ctx, calls } = recorderCtx();
    const { scene } = buildScene(calls, ctx);
    const ok = await scene.enableWasmTransforms(new Uint8Array([0, 1, 2, 3]));
    expect(ok).toBe(false);
    expect(scene.transformBackend).toBe('js');
  });
});
