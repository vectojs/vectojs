// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  Scene,
  Entity,
  TextEntity,
  SplineEntity,
  LayoutEngine,
  LayoutResultBuffer,
  type GlyphAtlas,
  type IRenderer,
} from '../src/index';

/**
 * Integration tests: exercise multiple modules together along real flows
 * (line-breaking, transforms, caching) rather than one class in isolation.
 */

// jsdom doesn't implement canvas getContext; stub it so the shared font
// measurer takes its portable null-fallback without logging "Not implemented".
// Per-instance getContext overrides (see sceneWithRecorder) still win.
HTMLCanvasElement.prototype.getContext = (() => null) as never;

// A recording 2D context so a real Scene + CanvasRenderer can be driven and the
// emitted draw calls inspected.
function recordingCtx() {
  const calls: { op: string; args: unknown[] }[] = [];
  const rec =
    (op: string) =>
    (...args: unknown[]) =>
      calls.push({ op, args });
  return {
    calls,
    scale: rec('scale'),
    clearRect: rec('clearRect'),
    save: rec('save'),
    restore: rec('restore'),
    translate: rec('translate'),
    rotate: rec('rotate'),
    beginPath: rec('beginPath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    bezierCurveTo: rec('bezierCurveTo'),
    closePath: rec('closePath'),
    arc: rec('arc'),
    roundRect: rec('roundRect'),
    drawImage: rec('drawImage'),
    fill: rec('fill'),
    stroke: rec('stroke'),
    fillText: rec('fillText'),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    set globalAlpha(_v: number) {},
    set fillStyle(_v: unknown) {},
    set strokeStyle(_v: unknown) {},
    set lineWidth(_v: number) {},
    set lineCap(_v: string) {},
    set lineJoin(_v: string) {},
    set font(_v: string) {},
    canvas: null as unknown,
  };
}

function sceneWithRecorder() {
  const ctx = recordingCtx();
  const parent = document.createElement('div');
  const canvas = document.createElement('canvas');
  parent.appendChild(canvas);
  // Force this canvas to hand back our recorder.
  (canvas as HTMLCanvasElement).getContext = (() => ctx) as never;
  ctx.canvas = canvas;
  const scene = new Scene(canvas);
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = () => 0;
  (scene as unknown as { isRunning: boolean }).isRunning = true;
  return { scene, ctx };
}

function tick(scene: Scene) {
  (scene as unknown as { loop: (t: number) => void }).loop(performance.now());
}

beforeEach(() => {
  (globalThis as { window?: unknown }).window = {
    innerWidth: 800,
    innerHeight: 600,
    devicePixelRatio: 1,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    navigator: { language: 'en-US' },
  };
});

describe('integration: line-breaking flow (LayoutEngine → TextEntity)', () => {
  // Monospace-like atlas: every glyph 10 wide at baseSize 10.
  const atlas: GlyphAtlas = Object.fromEntries(
    'ABCDE '.split('').map((c) => [c, { width: 10, baseSize: 10, ast: null }]),
  );

  it('wraps text and reports the longest-line width through to TextEntity bounds', () => {
    // maxWidth 35 fits "A B" (10+10+10=30) then wraps "C". Longest line = 30.
    const t = new TextEntity('A B C', atlas, 35, 10);
    expect(t.width).toBeGreaterThan(0);
    expect(t.width).toBeLessThanOrEqual(35); // not the full maxWidth (totalWidth fix)
    // hit area derives from the laid-out width, so a point past the text misses.
    t.setPosition(0, 0);
    expect(t.isPointInside(t.width + 5, 1)).toBe(false);
  });

  it('LayoutEngine and LayoutResultBuffer agree on wrapped positions', () => {
    const engine = new LayoutEngine(35, 1000);
    const nodes = engine.layoutText('A B C', atlas, 10).nodes;
    const buffer = new LayoutResultBuffer();
    engine.layoutTextIntoBuffer('A B C', atlas, 10, buffer);
    expect(buffer.count).toBe(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      expect(buffer.xs[i]).toBeCloseTo(nodes[i].x);
      expect(buffer.ys[i]).toBeCloseTo(nodes[i].y);
      expect(buffer.chars[i]).toBe(nodes[i].char);
    }
  });
});

describe('integration: transform flow (Scene render ↔ getGlobalPosition ↔ culling)', () => {
  it('a child renders under nested parent transform and its world pos matches the render translate', () => {
    const { scene, ctx } = sceneWithRecorder();

    class Group extends Entity {
      isPointInside() {
        return false;
      }
      render() {}
    }
    class Dot extends Entity {
      getBounds() {
        return { x: 0, y: 0, width: 4, height: 4 };
      }
      isPointInside() {
        return false;
      }
      render(r: IRenderer) {
        r.arc(0, 0, 2, 0, Math.PI * 2);
        r.fill('#fff');
      }
    }

    const parent = new Group('p');
    parent.setPosition(100, 50);
    parent.scaleX = 2;
    parent.scaleY = 2;
    const child = new Dot('c');
    child.setPosition(10, 10);
    parent.add(child);
    scene.add(parent);

    tick(scene);

    // getGlobalPosition: parent + scale*child = (100+2*10, 50+2*10) = (120, 70).
    const pos = child.getGlobalPosition();
    expect(pos.x).toBeCloseTo(120);
    expect(pos.y).toBeCloseTo(70);

    // The dot was actually rendered (on-screen, not culled).
    expect(ctx.calls.some((c) => c.op === 'arc')).toBe(true);
  });

  it('culls an off-screen child but still renders an on-screen sibling', () => {
    const { scene, ctx } = sceneWithRecorder();
    class Box extends Entity {
      constructor(
        id: string,
        private tag: string,
      ) {
        super(id);
      }
      getBounds() {
        return { x: 0, y: 0, width: 20, height: 20 };
      }
      isPointInside() {
        return false;
      }
      render(r: IRenderer) {
        r.fillText(this.tag, 0, 0, '10px monospace', '#fff');
      }
    }
    scene.add(new Box('on', 'ON').setPosition(10, 10));
    scene.add(new Box('off', 'OFF').setPosition(5000, 5000));

    tick(scene);

    const texts = ctx.calls.filter((c) => c.op === 'fillText').map((c) => c.args[0]);
    expect(texts).toContain('ON');
    expect(texts).not.toContain('OFF');
  });

  it('culling uses the same Canvas T*S*R order under non-uniform scale and rotation', () => {
    const { scene, ctx } = sceneWithRecorder();
    class Node extends Entity {
      constructor(private readonly label = '') {
        super();
      }
      getBounds() {
        return { x: 0, y: 0, width: 10, height: 10 };
      }
      isPointInside() {
        return false;
      }
      render(r: IRenderer) {
        if (this.label) r.fillText(this.label, 0, 0, '10px sans-serif', '#fff');
      }
    }

    const parent = new Node();
    parent.setPosition(400, 300);
    parent.scaleX = 10;
    parent.scaleY = 1;
    parent.rotation = Math.PI / 2;
    const child = new Node('VISIBLE');
    child.setPosition(50, 0);
    parent.add(child);
    scene.add(parent);

    tick(scene);

    expect(child.getGlobalPosition().x).toBeCloseTo(400);
    expect(child.getGlobalPosition().y).toBeCloseTo(350);
    expect(ctx.calls.some((call) => call.op === 'fillText' && call.args[0] === 'VISIBLE')).toBe(
      true,
    );
  });
});

describe('integration: caching flow', () => {
  it('LayoutResultBuffer reuse across relayouts yields stable results (zero-GC path)', () => {
    const atlas: GlyphAtlas = Object.fromEntries(
      'AB '.split('').map((c) => [c, { width: 10, baseSize: 10, ast: null }]),
    );
    const engine = new LayoutEngine(100, 1000);
    const buffer = new LayoutResultBuffer();

    engine.layoutTextIntoBuffer('A B', atlas, 10, buffer);
    const firstCount = buffer.count;
    const firstX = Array.from(buffer.xs.slice(0, firstCount));

    // Reusing the same buffer must reset and reproduce identical results.
    engine.layoutTextIntoBuffer('A B', atlas, 10, buffer);
    expect(buffer.count).toBe(firstCount);
    for (let i = 0; i < firstCount; i++) expect(buffer.xs[i]).toBeCloseTo(firstX[i]);
  });

  it('SplineEntity bakes once and reuses the cached canvas across frames', () => {
    let bakes = 0;
    class FakeOffscreen {
      width: number;
      height: number;
      constructor(w: number, h: number) {
        this.width = w;
        this.height = h;
      }
      getContext() {
        bakes++;
        return {
          translate: vi.fn(),
          beginPath: vi.fn(),
          moveTo: vi.fn(),
          bezierCurveTo: vi.fn(),
          stroke: vi.fn(),
          lineWidth: 0,
          lineCap: '',
          lineJoin: '',
          strokeStyle: '',
        };
      }
    }
    const prev = (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
    (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = FakeOffscreen;
    try {
      const { scene, ctx } = sceneWithRecorder();
      const spline = new SplineEntity({
        type: 'Spline',
        equations: [
          {
            color_rgb: [1, 1, 1],
            data: [{ start_t: 0, end_t: 1, x_poly: [0, 30, 0, 0], y_poly: [0, 0, 0, 0] }],
          },
        ],
        bounding_box: [0, 0, 30, 4],
      });
      scene.add(spline);

      tick(scene);
      tick(scene);
      tick(scene);

      expect(bakes).toBe(1); // baked exactly once
      const blits = ctx.calls.filter((c) => c.op === 'drawImage').length;
      expect(blits).toBe(3); // blitted each frame
    } finally {
      (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = prev;
    }
  });
});
