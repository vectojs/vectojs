// @vitest-environment jsdom
// G2 integration: Scene._tickBatchedDrivers advances active SpringDriver/named-
// easing TweenDriver instances through the WASM kernel instead of Entity's
// per-driver JS tick loop, when the driver-count gate is open. Every test here
// checks the INTEGRATED path (a real Scene + Entity tree + render loop), not
// the isolated kernel (already covered by anim-kernel.test.ts) — per the G3
// lesson, an isolated kernel's correctness says nothing about whether the
// gather/scatter/stamp wiring around it is correct.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Scene, Entity } from '../../src/index';
import { instantiateSync } from '../../src/wasm/anim-backend';

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
  scene.maxFPS = 0; // uncapped: every tick() call genuinely renders/advances
  return scene;
}
// sceneWith() bypasses Scene.start() (which would set lastTime = performance.now()),
// so a fresh scene's `lastTime` stays at its field default of 0 — `clock` must
// start there too, or the very first tick's dt is ~1000ms+ (clock's head start),
// enough to fast-forward a whole tween to completion on frame one regardless
// of anything under test.
let clock = 0;
function tickMs(scene: Scene, dtMs: number): void {
  clock += dtMs;
  (scene as unknown as { loop: (t: number) => void }).loop(clock);
}
/** Advance TWO scenes by the exact same dt in lockstep: each Scene computes
 *  its own `dt = time - lastTime`, so calling tickMs() on each scene
 *  separately (incrementing the shared `clock` twice) would hand them
 *  DIFFERENT absolute timestamps for what should be the same frame boundary
 *  — a real divergence source, not the tween-easing ULP drift this suite
 *  means to isolate. Advance the clock once and feed both the same value. */
function tickBoth(a: Scene, b: Scene, dtMs: number): void {
  clock += dtMs;
  (a as unknown as { loop: (t: number) => void }).loop(clock);
  (b as unknown as { loop: (t: number) => void }).loop(clock);
}
function enableWasmAnim(scene: Scene, gate = 1): void {
  scene.setAnimBackend(instantiateSync(bytes())!);
  scene.animDriverGateCount = gate;
  expect(scene.animBackend).toBe('wasm');
}
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0x100000000);
}

describe.skipIf(!haveWasm)('G2 — Scene batches active drivers through WASM', () => {
  // `clock` is module-level so tickMs()/tickBoth() can share it across a
  // test's several scenes — but that means it must be reset between tests,
  // or a freshly constructed scene's first loop() call (lastTime starts at 0)
  // sees a huge leftover `dt` from the previous test and fast-forwards any
  // tween straight to completion on frame 1.
  beforeEach(() => {
    clock = 0;
  });

  it('matches the JS-only path across many springs + named-easing tweens + custom-easing tweens', () => {
    setWindow();
    const jsScene = sceneWith();
    const wasmScene = sceneWith();
    enableWasmAnim(wasmScene, 1); // force the gate open from the first qualifying frame

    const rand = rng(0xbeef);
    const N = 90;
    const jsBoxes: Box[] = [];
    const wasmBoxes: Box[] = [];
    for (let i = 0; i < N; i++) {
      const kind = i % 3;
      const to = rand() * 200 - 100;
      // Draw every random parameter ONCE per entity index, then apply the
      // SAME captured values to both scenes' boxes below — drawing from
      // `rand()` again inside the per-scene loop would advance the shared RNG
      // twice and hand jsBoxes[i]/wasmBoxes[i] genuinely different physics
      // parameters, which is a divergence in the TEST fixture, not the code
      // under test.
      const stiffness = 120 + rand() * 200;
      const damping = 8 + rand() * 20;
      const duration = 300 + rand() * 400;
      for (const [scene, boxes] of [
        [jsScene, jsBoxes],
        [wasmScene, wasmBoxes],
      ] as const) {
        const b = new Box(`e${i}`);
        if (kind === 0) {
          b.setTransition({ x: { stiffness, damping } });
        } else if (kind === 1) {
          b.setTransition({ x: { duration, easing: 'easeOutCubic' } });
        } else {
          b.setTransition({ x: { duration, easing: (t) => t * t } }); // custom, non-batchable
        }
        scene.add(b);
        b.x = to; // triggers _spawnDriver via the transition
        boxes.push(b);
      }
    }

    for (let frame = 0; frame < 40; frame++) {
      tickBoth(jsScene, wasmScene, 16);
      for (let i = 0; i < N; i++) {
        expect(wasmBoxes[i].x).toBeCloseTo(jsBoxes[i].x, 6);
      }
    }
    // Sanity: motion actually happened, not a same-value coincidence.
    expect(jsBoxes.some((b) => b.x !== 0)).toBe(true);
  });

  it("a mixed entity's batchable AND non-batchable drivers both advance in the same claimed frame", () => {
    setWindow();
    const scene = sceneWith();
    enableWasmAnim(scene, 1);
    const b = new Box('mixed');
    scene.add(b);
    b.setTransition({
      x: { stiffness: 180, damping: 12 }, // batchable spring
      y: { duration: 200, easing: (t) => t }, // custom easing -> JS-only
    });
    b.x = 50;
    b.y = 50;

    tickMs(scene, 16);
    // Both properties must have moved off their start value after one frame —
    // neither was silently skipped because the entity was claimed as a whole.
    expect(b.x).not.toBe(0);
    expect(b.y).not.toBe(0);

    for (let i = 0; i < 30; i++) tickMs(scene, 16);
    expect(b.y).toBeCloseTo(50, 6); // custom-easing tween reaches target
  });

  it('an animation STARTED AFTER wasm batching is enabled still advances and completes (no freeze)', async () => {
    setWindow();
    const scene = sceneWith();
    enableWasmAnim(scene, 1);
    const b = new Box('late');
    scene.add(b);

    const done = b.animateTo({ x: 100 }, { duration: 160, easing: 'linear' });
    for (let i = 0; i < 15 && b.x < 100; i++) tickMs(scene, 16);
    await done;
    expect(b.x).toBe(100);
  });

  it('springTo/animateTo promises resolve when settled by the batch pass', async () => {
    setWindow();
    const scene = sceneWith();
    enableWasmAnim(scene, 1);
    const b = new Box('settles');
    scene.add(b);

    const springDone = b.springTo({ x: 10 });
    let resolved = false;
    springDone.then(() => (resolved = true));
    for (let i = 0; i < 300 && !resolved; i++) {
      tickMs(scene, 16);
      await Promise.resolve(); // flush the microtask queue
    }
    expect(resolved).toBe(true);
  });

  it('retarget mid-flight while wasm-batched matches the JS-only path (spring stays continuous, tween restarts cleanly)', () => {
    setWindow();
    const jsScene = sceneWith();
    const wasmScene = sceneWith();
    enableWasmAnim(wasmScene, 1);

    const jsSpring = new Box('spring');
    const wasmSpring = new Box('spring');
    for (const [scene, spring] of [
      [jsScene, jsSpring],
      [wasmScene, wasmSpring],
    ] as const) {
      scene.add(spring);
      spring.setTransition({ x: { stiffness: 180, damping: 12 } });
      spring.x = 100;
    }
    const jsTween = new Box('tween');
    const wasmTween = new Box('tween');
    for (const [scene, tween] of [
      [jsScene, jsTween],
      [wasmScene, wasmTween],
    ] as const) {
      scene.add(tween);
      tween.setTransition({ x: { duration: 200, easing: 'linear' } });
      tween.x = 100;
    }

    for (let i = 0; i < 6; i++) tickBoth(jsScene, wasmScene, 16); // partway through both
    expect(wasmSpring.x).toBeCloseTo(jsSpring.x, 6);
    expect(wasmTween.x).toBeCloseTo(jsTween.x, 6);
    // Sanity: retargeting below actually changes something meaningful.
    expect(jsTween.x).toBeGreaterThan(0);
    expect(jsTween.x).toBeLessThan(100);

    // Inject the SAME retarget on both scenes at the same frame boundary.
    jsSpring.x = 200;
    wasmSpring.x = 200;
    jsTween.x = 0;
    wasmTween.x = 0;

    for (let i = 0; i < 20; i++) {
      tickBoth(jsScene, wasmScene, 16);
      expect(wasmSpring.x).toBeCloseTo(jsSpring.x, 6);
      expect(wasmTween.x).toBeCloseTo(jsTween.x, 6);
    }
  });

  it('reduced motion still snaps instantly under wasm batching (never registered as a driver)', () => {
    setWindow();
    const scene = sceneWith();
    enableWasmAnim(scene, 1);
    (scene as unknown as { reducedMotionQuery: MediaQueryList }).reducedMotionQuery = {
      matches: true,
    } as MediaQueryList;
    expect(scene.prefersReducedMotion).toBe(true);
    const b = new Box('reduced');
    scene.add(b);
    b.setTransition({
      x: { duration: 300, easing: 'linear' },
      opacity: { duration: 300, easing: 'linear' },
    });
    b.x = 500;
    b.opacity = 0;
    expect(b.x).toBe(500); // movement snaps instantly under reduced motion
    // Reduced motion also caps the render loop itself to REDUCED_MOTION_FPS
    // (30fps, ~33.3ms/frame — see Scene.effectiveMaxFPS) independent of
    // anything G2-specific, so a single 16ms tick would be skipped as
    // arriving before the next allowed frame. Advance past that interval.
    tickMs(scene, 40);
    expect(b.opacity).toBeLessThan(1); // opacity fade still animates
  });

  it('gate closed (driver count below threshold): entities still animate via the unmodified JS path', () => {
    setWindow();
    const scene = sceneWith();
    scene.setAnimBackend(instantiateSync(bytes())!);
    scene.animDriverGateCount = 1_000_000; // never opens for this test's driver count
    const b = new Box('gated-off');
    scene.add(b);
    b.setTransition({ x: { duration: 100, easing: 'linear' } });
    b.x = 100;
    for (let i = 0; i < 8; i++) tickMs(scene, 16);
    expect(b.x).toBe(100);
  });

  it('registry self-prunes on completion/destroy and re-registers a fresh driver afterward', () => {
    setWindow();
    const scene = sceneWith();
    enableWasmAnim(scene, 1);
    const registry = (scene as unknown as { _activeDriverEntities: Set<Entity> })
      ._activeDriverEntities;

    const a = new Box('a');
    scene.add(a);
    a.setTransition({ x: { duration: 80, easing: 'linear' } });
    a.x = 10;
    expect(registry.has(a)).toBe(true);
    for (let i = 0; i < 10; i++) tickMs(scene, 16); // let it complete
    expect(a.x).toBe(10);
    tickMs(scene, 16); // one more frame: batch pass prunes the now-empty entity
    expect(registry.has(a)).toBe(false);

    // Re-driving the same entity re-registers it.
    a.x = 20;
    expect(registry.has(a)).toBe(true);

    const b = new Box('b');
    b.setTransition({ y: { duration: 80, easing: 'linear' } });
    scene.add(b);
    b.y = 5;
    b.destroy();
    tickMs(scene, 16); // batch pass must not throw on a destroyed-but-registered entity
    expect(registry.has(b)).toBe(false);
  });
});
