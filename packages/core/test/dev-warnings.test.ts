// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';

(globalThis as any).window = {
  innerWidth: 400,
  innerHeight: 300,
  devicePixelRatio: 1,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
};

function makeMockContext(canvas: HTMLCanvasElement) {
  const mockCtx: Record<string, any> = {
    canvas,
    scale: vi.fn(),
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    measureText: vi.fn(() => ({
      width: 20,
      actualBoundingBoxAscent: 12,
      actualBoundingBoxDescent: 4,
    })),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    rect: vi.fn(),
    roundRect: vi.fn(),
    clip: vi.fn(),
    closePath: vi.fn(),
    bezierCurveTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    setTransform: vi.fn(),
    drawImage: vi.fn(),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
  };
  [
    'fillStyle',
    'strokeStyle',
    'globalAlpha',
    'globalCompositeOperation',
    'lineWidth',
    'lineCap',
    'lineJoin',
    'shadowBlur',
    'shadowColor',
    'shadowOffsetX',
    'shadowOffsetY',
    'font',
    'textAlign',
    'textBaseline',
  ].forEach((prop) => {
    let _v: any;
    Object.defineProperty(mockCtx, prop, {
      get: () => _v,
      set: (v: any) => {
        _v = v;
      },
    });
  });
  return mockCtx;
}

HTMLCanvasElement.prototype.getContext = function (type: string) {
  if (type === '2d') return makeMockContext(this) as any;
  return null;
} as any;

import { Scene, Entity } from '../src/index';

function makeScene() {
  const canvas = document.createElement('canvas');
  canvas.width = 400;
  canvas.height = 300;
  const scene = new Scene(canvas, { contentProjection: false, disableWindowResize: true });
  scene.resize(400, 300);
  return { canvas, scene };
}

// Helper: run N frames to trigger dev checks (every 120th frame)
function runFrames(scene: Scene, n = 125) {
  for (let i = 0; i < n; i++) scene.step(16.67);
}

// `step()` renders but does not sync the a11y layer — that lives in the rAF
// `loop()`, which a test cannot drive. Projection-related checks therefore have
// to invoke the sync passes directly.
function runFramesWithA11y(scene: Scene, n = 125) {
  const s = scene as unknown as {
    syncA11y: (n: Entity) => void;
    enforceA11yDomOrder: () => void;
    root: Entity;
  };
  for (let i = 0; i < n; i++) {
    scene.step(16.67);
    s.syncA11y(s.root);
    s.enforceA11yDomOrder();
  }
}

describe('dev warnings — Scene.devMode', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    Scene.devMode = true;
  });

  afterAll(() => {
    Scene.devMode = false;
  });

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('warns when update() is overridden but not hasPendingAnimations()', () => {
    const { scene } = makeScene();
    class AnimatedEntity extends Entity {
      speed = 0.5;
      isPointInside() {
        return false;
      }
      render() {}
      override update(dt: number) {
        this.x += this.speed * dt;
      }
    }
    scene.add(new AnimatedEntity());
    runFrames(scene);
    expect(warnSpy).toHaveBeenCalled();
    const msg = warnSpy.mock.calls.map((c) => c[0]).join(' ');
    expect(msg).toContain('update');
    expect(msg).toContain('hasPendingAnimations');
  });

  it('does NOT warn when both update() and hasPendingAnimations() are overridden', () => {
    const { scene } = makeScene();
    class ProperEntity extends Entity {
      speed = 0.5;
      private moving = true;
      isPointInside() {
        return false;
      }
      render() {}
      override update(dt: number) {
        this.x += this.speed * dt;
      }
      override hasPendingAnimations() {
        return this.moving;
      }
    }
    scene.add(new ProperEntity());
    runFrames(scene);
    const warnings = warnSpy.mock.calls.filter((c) =>
      c[0]?.toString().includes('hasPendingAnimations'),
    );
    expect(warnings).toHaveLength(0);
  });

  it('does NOT warn when update() is not overridden', () => {
    const { scene } = makeScene();
    scene.add(
      new (class StaticEntity extends Entity {
        isPointInside() {
          return false;
        }
        render() {}
      })(),
    );
    runFrames(scene);
    const warnings = warnSpy.mock.calls.filter((c) =>
      c[0]?.toString().includes('hasPendingAnimations'),
    );
    expect(warnings).toHaveLength(0);
  });

  it('prunes tree-detached shadow nodes and warns on unreachable ones', () => {
    const { scene } = makeScene();
    // Re-enable content projection for a11y tracking
    (scene as any).contentProjectionEnabled = true;
    const ent = new (class InteractiveEntity extends Entity {
      isPointInside() {
        return false;
      }
      render() {}
      override getContentProjection() {
        return { text: 'hello', selectable: true };
      }
    })();
    ent.interactive = true;
    ent.width = 50;
    ent.height = 20;
    scene.add(ent);
    runFramesWithA11y(scene);
    expect(scene.a11yElements.size).toBe(1);

    // A tree-detached entity does NOT leak: enforceA11yDomOrder's prune pass
    // drops any element whose id is absent from activeIds, so the orphan is
    // cleaned up on the next sync. That is the real contract worth pinning.
    (scene.root as unknown as { children: Entity[] }).children.length = 0;
    warnSpy.mockClear();
    runFramesWithA11y(scene);

    expect(scene.a11yElements.size).toBe(0);
    const leakWarnings = warnSpy.mock.calls.filter((c) =>
      c[0]?.toString().includes('exceeds projectable entities'),
    );
    expect(leakWarnings).toHaveLength(0);

    // The warning fires for elements the prune pass cannot see — one injected
    // directly into the map, which models the state detachA11y() exists to
    // avoid. With the counter now using the projection predicate exactly, a
    // single stray element is enough; the previous `+2` slack hid this.
    const stray = document.createElement('div');
    scene.a11yElements.set('stray-node', stray);
    warnSpy.mockClear();
    scene.step(16.67);
    for (let i = 0; i < 130; i++) scene.step(16.67);

    const strayWarnings = warnSpy.mock.calls.filter((c) =>
      c[0]?.toString().includes('exceeds projectable entities'),
    );
    expect(strayWarnings.length).toBeGreaterThan(0);
  });

  it('does not warn when a11yFullViewport entities are projected', () => {
    // The counter must use the same predicate as projection. It previously
    // tested `interactive && width > 0`, which misses a11yFullViewport nodes
    // (projected at width 0) and needed +2 slack to stay quiet — slack that also
    // hid genuine one- and two-element leaks.
    const { scene } = makeScene();

    for (let i = 0; i < 4; i++) {
      const overlay = new (class Overlay extends Entity {
        isPointInside() {
          return false;
        }
        render() {}
      })();
      overlay.interactive = true;
      overlay.a11yFullViewport = true; // width stays 0
      scene.add(overlay);
    }
    runFramesWithA11y(scene);

    expect(scene.a11yElements.size).toBe(4);
    const leakWarnings = warnSpy.mock.calls.filter((c) =>
      c[0]?.toString().includes('exceeds projectable entities'),
    );
    expect(leakWarnings).toHaveLength(0);
  });
});
