// @vitest-environment jsdom
// Verifies the per-frame transform cache: renderNode populates each entity's
// cached cos/sin + world matrix, getWorldTransform() returns the cache while it
// is fresh and falls back to the walk when stale. Uses the same headless-Scene
// harness as Batching.test.ts (jsdom, null getContext, isRunning + loop()).
import { describe, it, expect, vi } from 'vitest';
import { Scene, Entity } from '../src/index';

HTMLCanvasElement.prototype.getContext = (() => null) as never;

class Box extends Entity {
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

/** Minimal 2D context: the walk only touches transform/state ops for no-op entities. */
function ctxMock() {
  let fillStyle = '';
  let alpha = 1;
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
  };
  return ctx;
}

function setWindow() {
  (globalThis as { window?: unknown }).window = {
    innerWidth: 800,
    innerHeight: 600,
    devicePixelRatio: 1,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
}

function sceneWith() {
  const ctx = ctxMock();
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

function tick(scene: Scene) {
  (scene as unknown as { loop: (t: number) => void }).loop(performance.now());
}

/** Reference composition (mirrors renderNode's T*S*R order). */
function compose(
  e: Entity,
  m: { a: number; b: number; c: number; d: number; e: number; f: number },
) {
  const cos = Math.cos(e.rotation);
  const sin = Math.sin(e.rotation);
  const a = m.a * (e.scaleX * cos) + m.c * (e.scaleY * sin);
  const b = m.b * (e.scaleX * cos) + m.d * (e.scaleY * sin);
  const c = m.a * -(e.scaleX * sin) + m.c * (e.scaleY * cos);
  const d = m.b * -(e.scaleX * sin) + m.d * (e.scaleY * cos);
  const ee = m.a * e.x + m.c * e.y + m.e;
  const f = m.b * e.x + m.d * e.y + m.f;
  return { a, b, c, d, e: ee, f };
}

describe('per-frame transform cache', () => {
  it('getWorldTransform after a render equals the independently composed transform', () => {
    setWindow();
    const scene = sceneWith();
    const parent = new Box('p');
    parent.setPosition(30, 40);
    parent.rotation = 0.3;
    parent.scaleX = 2;
    const child = new Box('c');
    child.setPosition(5, -7);
    child.rotation = -0.1;
    parent.add(child);
    scene.add(parent);

    tick(scene); // one render walk populates the cache

    const cached = child.getWorldTransform();
    let m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    m = compose(parent, m);
    m = compose(child, m);
    expect(cached.a).toBeCloseTo(m.a, 9);
    expect(cached.b).toBeCloseTo(m.b, 9);
    expect(cached.c).toBeCloseTo(m.c, 9);
    expect(cached.d).toBeCloseTo(m.d, 9);
    expect(cached.e).toBeCloseTo(m.e, 9);
    expect(cached.f).toBeCloseTo(m.f, 9);
  });

  it('cos/sin recompute only when rotation changes', () => {
    const e = new Box();
    e.rotation = 0.5;
    const first = (e as any)._getTrig();
    const again = (e as any)._getTrig();
    expect(again).toBe(first); // same cached object, no recompute
    expect(first.cos).toBeCloseTo(Math.cos(0.5), 12);
    e.rotation = 0.6;
    const after = (e as any)._getTrig();
    expect(after.cos).toBeCloseTo(Math.cos(0.6), 12);
    expect(after.sin).toBeCloseTo(Math.sin(0.6), 12);
  });

  it('cache is used only for the frame it was written, else falls back to the walk', () => {
    setWindow();
    const scene = sceneWith();
    const e = new Box('solo');
    e.setPosition(11, 22);
    e.rotation = 0.25;
    scene.add(e);

    // Directly seed a bogus cache for the *current* frame — getWorldTransform
    // must trust it (proves the cache path is taken)…
    const frame = (scene as unknown as { currentFrame: number }).currentFrame;
    (e as any)._setWorldCache(9, 9, 9, 9, 9, 9, frame);
    expect(e.getWorldTransform().a).toBe(9);

    // …then advance the frame: the stale cache is ignored and the real walk runs.
    (scene as unknown as { currentFrame: number }).currentFrame = frame + 1;
    const walked = e.getWorldTransform();
    expect(walked.a).toBeCloseTo(Math.cos(0.25), 9);
    expect(walked.e).toBeCloseTo(11, 9);
    expect(walked.f).toBeCloseTo(22, 9);
  });
});
