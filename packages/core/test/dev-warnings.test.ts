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

import { Scene, Entity, SCENE_OPTION_KEYS, CanvasRenderer, setRendererDevMode } from '../src/index';

function makeScene() {
  const canvas = document.createElement('canvas');
  canvas.width = 400;
  canvas.height = 300;
  const scene = new Scene(canvas, {
    contentProjection: false,
    disableWindowResize: true,
  });
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

  it('warns on an unknown SceneOptions key and names the closest real one', () => {
    const canvas = document.createElement('canvas');
    // `renderMode` is a field, not an option — the exact mistake that shipped
    // four motif demos repainting at core's 2fps idle floor while their source
    // read `renderMode: 'onDemand'`.
    new Scene(canvas, {
      disableWindowResize: true,
      contentProjection: false,
      rendreMode: 'onDemand',
    } as never);

    const msg = warnSpy.mock.calls.map((c) => c[0]).join(' ');
    expect(msg).toContain('rendreMode');
    // A bare "unknown key" warning is not enough to act on; the suggestion is
    // what turns it into a fix.
    expect(msg).toContain('renderMode');
  });

  it('does NOT warn for renderMode, which is now a real option', () => {
    const canvas = document.createElement('canvas');
    new Scene(canvas, {
      disableWindowResize: true,
      contentProjection: false,
      renderMode: 'onDemand',
    });

    const optionWarnings = warnSpy.mock.calls.filter((c) =>
      c[0]?.toString().includes('SceneOptions'),
    );
    expect(optionWarnings).toHaveLength(0);
  });

  it('points at the assignment form for a field mistaken as an option', () => {
    const canvas = document.createElement('canvas');
    new Scene(canvas, {
      disableWindowResize: true,
      contentProjection: false,
      devMode: true,
    } as never);

    const msg = warnSpy.mock.calls.map((c) => c[0]).join(' ');
    expect(msg).toContain('devMode');
    expect(msg).toContain('Scene.devMode');
  });

  it('keeps SCENE_OPTION_KEYS in sync with what the constructor accepts', () => {
    // A new option added to the interface but missing from the list would warn
    // on legitimate use; the reverse would stay silent on a typo.
    const canvas = document.createElement('canvas');
    const everyKey: Record<string, unknown> = {
      a11ySyncInterval: 0,
      autoThrottle: false,
      contentProjection: false,
      contentProjectionMargin: 10,
      contentSemanticBudget: 32,
      contentSemanticMargin: 20,
      debugA11y: false,
      disableWindowResize: true,
      maxDPR: 2,
      maxFPS: 30,
      particleBackend: 'cpu',
      pointBackend: 'canvas',
      readingDirection: 'ltr',
      renderMode: 'onDemand',
      respectReducedMotion: false,
      userTiming: false,
    };
    // `renderer` is omitted deliberately: it needs a real IRenderer instance.
    expect(Object.keys(everyKey).length).toBe(SCENE_OPTION_KEYS.length - 1);
    for (const k of Object.keys(everyKey)) {
      expect(SCENE_OPTION_KEYS).toContain(k);
    }

    new Scene(canvas, everyKey as never);
    const optionWarnings = warnSpy.mock.calls.filter((c) =>
      c[0]?.toString().includes('SceneOptions'),
    );
    expect(optionWarnings).toHaveLength(0);
  });

  it('does NOT warn for a fully valid option set', () => {
    const canvas = document.createElement('canvas');
    new Scene(canvas, {
      disableWindowResize: true,
      contentProjection: false,
      maxFPS: 30,
      autoThrottle: false,
      readingDirection: 'rtl',
      maxDPR: 2,
    });

    const optionWarnings = warnSpy.mock.calls.filter((c) =>
      c[0]?.toString().includes('SceneOptions'),
    );
    expect(optionWarnings).toHaveLength(0);
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

describe('dev warnings — property-shaped writes to a renderer', () => {
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

  function makeRenderer() {
    const canvas = document.createElement('canvas');
    canvas.width = 100;
    canvas.height = 100;
    return new CanvasRenderer(canvas, { width: 100, height: 100 });
  }

  it('warns on `globalAlpha =` and names setGlobalAlpha', () => {
    const r = makeRenderer() as unknown as Record<string, unknown>;
    // The exact mistake that shipped in two motif demos: this attaches an
    // expando and the draw keeps the context default, so a slider bound to it
    // does nothing visible.
    r.globalAlpha = 0.5;

    const msg = warnSpy.mock.calls.map((c) => c[0]).join(' ');
    expect(msg).toContain('globalAlpha');
    expect(msg).toContain('setGlobalAlpha');
  });

  it('warns on `strokeStyle =` and `lineWidth =`, naming stroke()', () => {
    const r = makeRenderer() as unknown as Record<string, unknown>;
    r.strokeStyle = 'rgba(255,255,255,0.25)';
    r.lineWidth = 1.5;

    const msg = warnSpy.mock.calls.map((c) => c[0]).join(' ');
    expect(msg).toContain('strokeStyle');
    expect(msg).toContain('lineWidth');
    expect(msg).toContain('stroke(');
  });

  it('warns once per property, not once per write', () => {
    const r = makeRenderer() as unknown as Record<string, unknown>;
    for (let i = 0; i < 10; i++) r.globalAlpha = i / 10;

    const alphaWarnings = warnSpy.mock.calls.filter((c) =>
      c[0]?.toString().includes('globalAlpha'),
    );
    // A per-frame assignment would otherwise flood the console at 240fps.
    expect(alphaWarnings).toHaveLength(1);
  });

  it('does NOT warn for correct method calls', () => {
    const r = makeRenderer();
    r.setGlobalAlpha(0.5);
    r.beginPath();
    r.moveTo(0, 0);
    r.lineTo(10, 10);
    r.stroke('rgba(255,255,255,0.25)', 1.5);
    r.fill('#fff');

    const rendererWarnings = warnSpy.mock.calls.filter((c) =>
      c[0]?.toString().includes('is not a renderer property'),
    );
    expect(rendererWarnings).toHaveLength(0);
  });

  it('still reads back what was assigned, so a warned write is not a hard break', () => {
    const r = makeRenderer() as unknown as Record<string, unknown>;
    r.globalAlpha = 0.42;
    // The trap must not change behavior beyond warning: code that assigns and
    // then reads its own value keeps working, it just also gets told.
    expect(r.globalAlpha).toBe(0.42);
  });

  it('does not warn when dev mode is off', () => {
    Scene.devMode = false;
    // The renderer layer holds its own published flag (it cannot import Scene),
    // so clearing dev mode means clearing both.
    setRendererDevMode(false);
    try {
      const r = makeRenderer() as unknown as Record<string, unknown>;
      r.globalAlpha = 0.5;
      expect(warnSpy).not.toHaveBeenCalled();
      // And the property must behave as a plain field, not vanish.
      expect(r.globalAlpha).toBe(0.5);
    } finally {
      Scene.devMode = true;
      setRendererDevMode(true);
    }
  });

  it('arms a renderer built without any Scene', () => {
    // `Scene.devMode = true` must reach a directly-constructed renderer, which
    // is why devMode is an accessor that publishes rather than a plain field.
    // With a field, this only worked when some earlier test happened to build a
    // Scene first — the trap silently did nothing for standalone renderer use.
    setRendererDevMode(false);
    Scene.devMode = true;

    const r = makeRenderer() as unknown as Record<string, unknown>;
    r.globalAlpha = 0.5;
    expect(warnSpy.mock.calls.map((c) => c[0]).join(' ')).toContain('setGlobalAlpha');
  });

  it('warns for each of the six lines that actually shipped in motif', () => {
    const r = makeRenderer() as unknown as Record<string, unknown>;
    // frosted-glass/demo.js:137,139 + glow-bloom/demo.js:61,63
    r.globalAlpha = 0.6;
    // frosted-glass/demo.js:142,143
    r.strokeStyle = 'rgba(255,255,255,0.25)';
    r.lineWidth = 1.5;

    const msgs = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(msgs.some((m) => m.includes('setGlobalAlpha'))).toBe(true);
    expect(msgs.filter((m) => m.includes('stroke(color, lineWidth)'))).toHaveLength(2);
    expect(msgs).toHaveLength(3);
  });
});
