// @vitest-environment jsdom
// G3 integration: findEntityAt reads from the WASM hit-test grid, with the JS
// depth-first walk (findHitRecursively) as the permanent fallback. Every test
// asserts the WASM path returns the EXACT SAME entity as the JS-only path for
// the same query — the grid is a coarse pre-filter, never a source of truth by
// itself (see hit-store.ts / Scene.ts's _findEntityAtWasm for why).
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Scene, Entity, type Bounds } from '../../src/index';
import { instantiateSync } from '../../src/wasm/hit-backend';

HTMLCanvasElement.prototype.getContext = (() => null) as never;

const wasmPath = resolve(process.cwd(), 'src/wasm/vectojs_core.wasm');
const haveWasm = existsSync(wasmPath);
const bytes = () => readFileSync(wasmPath);

/** Axis-aligned rectangle: precise hit test == its own AABB. */
class RectEntity extends Entity {
  constructor(
    id: string,
    public width: number,
    public height: number,
  ) {
    super(id);
  }
  getBounds(): Bounds {
    return { x: 0, y: 0, width: this.width, height: this.height };
  }
  isPointInside(gx: number, gy: number): boolean {
    const local = this.worldToLocal(gx, gy);
    if (!local) return false;
    return local.x >= 0 && local.x <= this.width && local.y >= 0 && local.y <= this.height;
  }
  render(): void {}
}

/** A circle whose AABB (a bounding square) is intentionally bigger than its
 *  actual hit area — a query inside the AABB corner but outside the radius
 *  must fall through to the next candidate, proving the grid never trusts the
 *  AABB alone. */
class CircleEntity extends Entity {
  constructor(
    id: string,
    public radius: number,
  ) {
    super(id);
  }
  getBounds(): Bounds {
    return { x: -this.radius, y: -this.radius, width: this.radius * 2, height: this.radius * 2 };
  }
  isPointInside(gx: number, gy: number): boolean {
    const local = this.worldToLocal(gx, gy);
    if (!local) return false;
    return local.x * local.x + local.y * local.y <= this.radius * this.radius;
  }
  render(): void {}
}

/** Opts out of culling (and, by construction, out of the WASM grid). */
class BoundlessEntity extends Entity {
  constructor(
    id: string,
    public size: number,
  ) {
    super(id);
  }
  getBounds(): null {
    return null;
  }
  isPointInside(gx: number, gy: number): boolean {
    const local = this.worldToLocal(gx, gy);
    if (!local) return false;
    return local.x >= 0 && local.x <= this.size && local.y >= 0 && local.y <= this.size;
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
  return scene;
}
let clock = 1000;
function tick(scene: Scene): void {
  clock += 100;
  (scene as unknown as { loop: (t: number) => void }).loop(clock);
}
function enableWasmHit(scene: Scene): void {
  scene.setHitTestBackend(instantiateSync(bytes())!);
  expect(scene.hitTestBackend).toBe('wasm');
}
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0x100000000);
}

describe.skipIf(!haveWasm)('G3 — findEntityAt reads the WASM hit-test grid', () => {
  it('matches the JS walk across many overlapping entities and random query points', () => {
    setWindow();
    const scene = sceneWith();
    const rand = rng(0xf1d);
    const entities: RectEntity[] = [];
    for (let i = 0; i < 300; i++) {
      const e = new RectEntity(`r${i}`, 10 + rand() * 40, 10 + rand() * 40);
      e.x = rand() * 400;
      e.y = rand() * 300;
      entities.push(e);
      scene.add(e);
    }
    tick(scene); // JS-mode authoritative pass

    const points: [number, number][] = [];
    const q = rng(0xa11ce);
    for (let i = 0; i < 500; i++) points.push([q() * 400, q() * 300]);
    const jsResults = points.map(([px, py]) => scene.findEntityAt(px, py)?.id ?? null);

    enableWasmHit(scene);
    tick(scene); // wasm-mode pass (grid built lazily on first findEntityAt below)
    const wasmResults = points.map(([px, py]) => scene.findEntityAt(px, py)?.id ?? null);

    expect(wasmResults).toEqual(jsResults);
    // Sanity: the fixture actually produces some hits, not an empty scene.
    expect(jsResults.some((id) => id !== null)).toBe(true);
  });

  it('falls through to the next-topmost candidate when the top AABB match misses precisely', () => {
    setWindow();
    const scene = sceneWith();
    // A wide square UNDER a small circle. Both centered at (100,100); the
    // circle's bounding square is the SAME size as the rect, so a query in
    // the rect's corner (inside both AABBs, outside the circle's radius) must
    // resolve to the rect, not null and not a wrong match.
    const rect = new RectEntity('rect', 60, 60);
    rect.x = 70;
    rect.y = 70;
    const circle = new CircleEntity('circle', 30); // bounding box also 60x60 at (70,70)-(130,130)
    circle.x = 100;
    circle.y = 100;
    scene.add(rect);
    scene.add(circle); // added after rect -> topmost

    enableWasmHit(scene);
    tick(scene);

    // Dead center: inside the circle's actual radius -> circle wins (topmost).
    expect(scene.findEntityAt(100, 100)?.id).toBe('circle');
    // Near the shared AABB's corner: inside both AABBs, outside the circle's
    // radius -> must fall through to the rect underneath.
    expect(scene.findEntityAt(72, 72)?.id).toBe('rect');
    // Outside both entirely.
    expect(scene.findEntityAt(5, 5)).toBeNull();
  });

  it('finds a boundless entity (no getBounds) and respects its z-order', () => {
    setWindow();
    const scene = sceneWith();
    const under = new RectEntity('under', 50, 50);
    under.x = 100;
    under.y = 100;
    const boundless = new BoundlessEntity('boundless', 50);
    boundless.x = 100;
    boundless.y = 100;
    scene.add(under);
    scene.add(boundless); // added after -> topmost

    enableWasmHit(scene);
    tick(scene);
    expect(scene.findEntityAt(120, 120)?.id).toBe('boundless');

    // Reverse the z-order: boundless added first (underneath) this time.
    const scene2 = sceneWith();
    const boundless2 = new BoundlessEntity('boundless2', 50);
    boundless2.x = 100;
    boundless2.y = 100;
    const over = new RectEntity('over', 50, 50);
    over.x = 100;
    over.y = 100;
    scene2.add(boundless2);
    scene2.add(over);
    enableWasmHit(scene2);
    tick(scene2);
    expect(scene2.findEntityAt(120, 120)?.id).toBe('over');
  });

  it('overlay hits always win over the main tree, in both js and wasm modes', () => {
    setWindow();
    const scene = sceneWith();
    const main = new RectEntity('main', 400, 300); // covers the whole viewport
    scene.add(main);
    const overlay = new RectEntity('overlay', 50, 50);
    overlay.x = 100;
    overlay.y = 100;
    scene.showOverlay(overlay);

    enableWasmHit(scene);
    tick(scene);
    expect(scene.findEntityAt(120, 120)?.id).toBe('overlay');
    expect(scene.findEntityAt(5, 5)?.id).toBe('main'); // outside the overlay
  });

  it('stays correct after entities move (grid rebuilt lazily, not stale)', () => {
    setWindow();
    const scene = sceneWith();
    const a = new RectEntity('a', 40, 40);
    a.x = 10;
    a.y = 10;
    scene.add(a);
    enableWasmHit(scene);
    tick(scene);
    expect(scene.findEntityAt(20, 20)?.id).toBe('a');
    expect(scene.findEntityAt(200, 200)).toBeNull();

    a.x = 190;
    a.y = 190;
    tick(scene); // a new rendered frame -> the grid must refresh
    expect(scene.findEntityAt(20, 20)).toBeNull(); // old position, no longer there
    expect(scene.findEntityAt(200, 200)?.id).toBe('a'); // new position
  });

  it('hot-swap lifecycle: starts on JS, enableWasmHitTest succeeds/fails correctly', async () => {
    setWindow();
    const scene = sceneWith();
    const e = new RectEntity('e', 20, 20);
    e.x = 10;
    e.y = 10;
    scene.add(e);
    expect(scene.hitTestBackend).toBe('js');
    tick(scene);
    expect(scene.findEntityAt(15, 15)?.id).toBe('e');

    const ok = await scene.enableWasmHitTest(bytes());
    expect(ok).toBe(true);
    expect(scene.hitTestBackend).toBe('wasm');
    tick(scene);
    expect(scene.findEntityAt(15, 15)?.id).toBe('e');

    const scene2 = sceneWith();
    const failed = await scene2.enableWasmHitTest(new Uint8Array([1, 2, 3]));
    expect(failed).toBe(false);
    expect(scene2.hitTestBackend).toBe('js');

    scene.setHitTestBackend(null);
    expect(scene.hitTestBackend).toBe('js');
    tick(scene);
    expect(scene.findEntityAt(15, 15)?.id).toBe('e');
  });
});
