// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

// Scene requires a real canvas, so we mock the DOM
const mockCtx = {
  scale: vi.fn(),
  clearRect: vi.fn(),
  save: vi.fn(),
  restore: vi.fn(),
  translate: vi.fn(),
  rotate: vi.fn(),
  fillText: vi.fn(),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  arc: vi.fn(),
  fill: vi.fn(),
  rect: vi.fn(),
  clip: vi.fn(),
  set globalAlpha(_v: number) {},
};

const mockCanvas = {
  getContext: () => mockCtx,
  width: 0,
  height: 0,
  style: { width: '', height: '' },
  parentElement: null,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
};

// Globally mock JSDom's canvas context
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() => mockCtx) as any;
}

// Minimal window mock for CanvasRenderer
(globalThis as any).window = {
  innerWidth: 800,
  innerHeight: 600,
  devicePixelRatio: 1,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
};
import { Scene, Entity, CanvasRenderer, ComputeParticleEntity, DOMPortalEntity } from '../src';

// Entity is abstract; use a minimal concrete subclass for tests.
class TestEntity extends Entity {
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

describe('Scene', () => {
  it('should support export to SVG XML string via toSVG()', () => {
    const scene = new Scene(mockCanvas as any);
    const xml = scene.toSVG();
    expect(xml).toContain('svg');
  });

  it('toSVG snapshots current state without advancing entities, while step advances them', () => {
    class UpdatingEntity extends TestEntity {
      updates = 0;
      override update(dt: number, time: number): void {
        super.update(dt, time);
        this.updates++;
      }
    }
    const scene = new Scene(mockCanvas as any, { particleBackend: 'cpu' });
    const entity = new UpdatingEntity();
    const particles = new ComputeParticleEntity({ maxParticles: 1 });
    const updateCPU = vi.spyOn(particles, 'updateCPU');
    scene.add(entity);
    scene.add(particles);

    scene.toSVG();
    expect(entity.updates).toBe(0);
    expect(updateCPU).not.toHaveBeenCalled();

    scene.step(16);
    expect(entity.updates).toBe(1);
    expect(updateCPU).toHaveBeenCalledTimes(1);
  });

  it('toSVG does not mutate a11y z-order or mount DOM portals', () => {
    const parent = document.createElement('div');
    const canvas = document.createElement('canvas');
    parent.appendChild(canvas);
    const scene = new Scene(canvas);
    const interactive = new TestEntity('interactive');
    interactive.interactive = true;
    interactive.width = 50;
    interactive.height = 20;
    scene.add(interactive);
    (scene as any).syncA11y((scene as any).root);
    const a11yElement = scene.getA11yElement(interactive.id)!;
    a11yElement.style.zIndex = '77';

    const portalElement = document.createElement('div');
    const portal = new DOMPortalEntity(portalElement, 100, 50);
    scene.add(portal);

    scene.toSVG();

    expect(a11yElement.style.zIndex).toBe('77');
    expect(portalElement.parentElement).toBeNull();
  });

  it('add() increases root child count', () => {
    const scene = new Scene(mockCanvas as any);
    const e = new TestEntity();
    scene.add(e);
    // Access root via the private scene graph
    expect((scene as any).root.children.length).toBe(1);
  });

  it('remove() decreases root child count', () => {
    const scene = new Scene(mockCanvas as any);
    const e = new TestEntity();
    scene.add(e);
    scene.remove(e);
    expect((scene as any).root.children.length).toBe(0);
  });

  it('start() is idempotent', () => {
    const scene = new Scene(mockCanvas as any);
    (globalThis as any).requestAnimationFrame = vi.fn();
    scene.start();
    scene.start(); // second call must not schedule two loops
    expect((globalThis as any).requestAnimationFrame).toHaveBeenCalledTimes(1);
  });

  it('stop() halts the loop flag', () => {
    const scene = new Scene(mockCanvas as any);
    scene.start();
    scene.stop();
    expect((scene as any).isRunning).toBe(false);
  });

  it('maps viewport coordinates through the canvas CSS rect into logical Scene space', () => {
    const canvas = document.createElement('canvas');
    const scene = new Scene(canvas, { disableWindowResize: true });
    scene.width = 800;
    scene.height = 600;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      top: 50,
      width: 400,
      height: 300,
      right: 500,
      bottom: 350,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    });

    expect(scene.clientToScene(300, 200)).toEqual({ x: 400, y: 300 });
  });

  it('aligns and scales the accessibility overlay to the canvas CSS box', () => {
    const parent = document.createElement('div');
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    parent.appendChild(canvas);
    document.body.appendChild(parent);
    vi.spyOn(parent, 'getBoundingClientRect').mockReturnValue({
      left: 50,
      top: 30,
      width: 1000,
      height: 800,
      right: 1050,
      bottom: 830,
      x: 50,
      y: 30,
      toJSON: () => ({}),
    });
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 150,
      top: 90,
      width: 400,
      height: 300,
      right: 550,
      bottom: 390,
      x: 150,
      y: 90,
      toJSON: () => ({}),
    });

    const scene = new Scene(canvas, { disableWindowResize: true });
    const entity = new TestEntity('scaled-control');
    entity.interactive = true;
    entity.width = 100;
    entity.height = 40;
    scene.add(entity);
    scene.render(scene.getRenderer(), 0, 0);

    const overlay = (scene as any).a11yRoot as HTMLElement;
    expect(overlay.style.left).toBe('100px');
    expect(overlay.style.top).toBe('60px');
    expect(overlay.style.width).toBe('800px');
    expect(overlay.style.height).toBe('600px');
    expect(overlay.style.transformOrigin).toBe('0 0');
    expect(overlay.style.transform).toBe('scale(0.5, 0.5)');

    scene.destroy();
    parent.remove();
  });

  it('destroy() halts loop, removes listeners, and clears A11y DOM', () => {
    const parentDiv = document.createElement('div');
    const canvas = document.createElement('canvas');
    parentDiv.appendChild(canvas);

    const scene = new Scene(canvas);

    const e1 = new TestEntity('child1');
    e1.interactive = true;
    e1.width = 100;
    e1.height = 100;
    scene.add(e1);

    (scene as any).syncA11y((scene as any).root);
    expect((scene as any).a11yElements.has('child1')).toBe(true);

    scene.destroy();
    expect((scene as any).isRunning).toBe(false);
    expect((scene as any).a11yElements.size).toBe(0);
  });

  it('destroy() disposes a custom renderer exactly once', () => {
    const canvas = document.createElement('canvas');
    const renderer = new CanvasRenderer(canvas);
    const dispose = vi.spyOn(renderer, 'dispose');
    const scene = new Scene(canvas, { renderer });

    scene.destroy();
    scene.destroy();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('destroy() tears down every owned entity and its GPU resources', () => {
    const scene = new Scene(mockCanvas as any);
    const parent = new TestEntity('parent');
    const child = new TestEntity('child');
    const childDestroy = vi.spyOn(child, 'destroy');
    const particles = new ComputeParticleEntity({ maxParticles: 1 });
    const storageDestroy = vi.fn();
    const uniformDestroy = vi.fn();
    particles.gpuStorageBuffer = { destroy: storageDestroy };
    particles.gpuUniformBuffer = { destroy: uniformDestroy };
    parent.add(child);
    parent.add(particles);
    scene.add(parent);

    scene.destroy();

    expect(childDestroy).toHaveBeenCalledOnce();
    expect(storageDestroy).toHaveBeenCalledOnce();
    expect(uniformDestroy).toHaveBeenCalledOnce();
    expect(scene.getRoot().children).toHaveLength(0);
  });

  it('destroy() accepts a renderer without an explicit dispose hook', () => {
    const canvas = document.createElement('canvas');
    const renderer = new CanvasRenderer(canvas);
    Object.defineProperty(renderer, 'dispose', { value: undefined });
    const scene = new Scene(canvas, { renderer });

    expect(() => scene.destroy()).not.toThrow();
  });

  it('remove() cleans A11y DOM elements recursively', () => {
    const parentDiv = document.createElement('div');
    const canvas = document.createElement('canvas');
    parentDiv.appendChild(canvas);

    const scene = new Scene(canvas);

    const parentEntity = new TestEntity('parent');
    parentEntity.interactive = true;
    parentEntity.width = 100;
    parentEntity.height = 100;

    const childEntity = new TestEntity('child');
    childEntity.interactive = true;
    childEntity.width = 50;
    childEntity.height = 50;

    parentEntity.add(childEntity);
    scene.add(parentEntity);

    (scene as any).syncA11y((scene as any).root);
    expect((scene as any).a11yElements.has('parent')).toBe(true);
    expect((scene as any).a11yElements.has('child')).toBe(true);

    scene.remove(parentEntity);
    expect((scene as any).a11yElements.has('parent')).toBe(false);
    expect((scene as any).a11yElements.has('child')).toBe(false);
  });

  it('syncA11y builds the shadow node from getA11yAttributes()', () => {
    const parentDiv = document.createElement('div');
    const canvas = document.createElement('canvas');
    parentDiv.appendChild(canvas);
    const scene = new Scene(canvas);

    class LinkLike extends Entity {
      isPointInside() {
        return false;
      }
      render() {}
      getA11yAttributes() {
        return { tag: 'a' as const, role: 'link', label: 'Docs', href: 'https://example.com' };
      }
    }
    const link = new LinkLike('lnk');
    link.interactive = true;
    link.width = 80;
    link.height = 20;
    scene.add(link);

    (scene as any).syncA11y((scene as any).root);
    const el = (scene as any).a11yElements.get('lnk') as HTMLElement;
    expect(el.tagName).toBe('A');
    expect(el.getAttribute('role')).toBe('link');
    expect(el.getAttribute('aria-label')).toBe('Docs');
    expect((el as HTMLAnchorElement).href).toContain('example.com');
  });

  it('syncA11y builds an <img> with src/alt', () => {
    const parentDiv = document.createElement('div');
    const canvas = document.createElement('canvas');
    parentDiv.appendChild(canvas);
    const scene = new Scene(canvas);

    class ImgLike extends Entity {
      isPointInside() {
        return false;
      }
      render() {}
      getA11yAttributes() {
        return { tag: 'img' as const, src: 'https://example.com/logo.png', alt: 'Logo' };
      }
    }
    const img = new ImgLike('img');
    img.interactive = true;
    img.width = 64;
    img.height = 64;
    scene.add(img);

    (scene as any).syncA11y((scene as any).root);
    const el = (scene as any).a11yElements.get('img') as HTMLImageElement;
    expect(el.tagName).toBe('IMG');
    expect(el.src).toContain('logo.png');
    expect(el.alt).toBe('Logo');
  });

  it('syncA11y builds an <input> and refreshes value/checked each frame', () => {
    const parentDiv = document.createElement('div');
    const canvas = document.createElement('canvas');
    parentDiv.appendChild(canvas);
    const scene = new Scene(canvas);

    let checked = false;
    class CheckLike extends Entity {
      isPointInside() {
        return false;
      }
      render() {}
      getA11yAttributes() {
        return { tag: 'input' as const, inputType: 'checkbox', label: 'Agree', checked };
      }
    }
    const c = new CheckLike('chk');
    c.interactive = true;
    c.width = 20;
    c.height = 20;
    scene.add(c);

    (scene as any).syncA11y((scene as any).root);
    const el = (scene as any).a11yElements.get('chk') as HTMLInputElement;
    expect(el.tagName).toBe('INPUT');
    expect(el.type).toBe('checkbox');
    expect(el.checked).toBe(false);

    // State change is reflected on the next sync (single element, refreshed).
    checked = true;
    (scene as any).syncA11y((scene as any).root);
    expect(el.checked).toBe(true);
    expect((scene as any).a11yElements.size).toBe(1);
  });

  it('syncA11y defaults to a div when getA11yAttributes is not overridden', () => {
    const parentDiv = document.createElement('div');
    const canvas = document.createElement('canvas');
    parentDiv.appendChild(canvas);
    const scene = new Scene(canvas);

    const e = new TestEntity('plain');
    e.interactive = true;
    e.width = 50;
    e.height = 50;
    scene.add(e);

    (scene as any).syncA11y((scene as any).root);
    expect(((scene as any).a11yElements.get('plain') as HTMLElement).tagName).toBe('DIV');
  });

  it('syncA11y adds tabindex and keydown listener for interactive roles on non-native elements', () => {
    const parentDiv = document.createElement('div');
    const canvas = document.createElement('canvas');
    parentDiv.appendChild(canvas);
    const scene = new Scene(canvas);

    class SwitchLike extends Entity {
      isPointInside() {
        return false;
      }
      render() {}
      getA11yAttributes() {
        return { tag: 'div' as const, role: 'switch', label: 'Toggle' };
      }
    }
    const s = new SwitchLike('sw');
    s.interactive = true;
    s.width = 40;
    s.height = 20;
    scene.add(s);

    class GroupLike extends Entity {
      isPointInside() {
        return false;
      }
      render() {}
      getA11yAttributes() {
        return { tag: 'div' as const, role: 'group' };
      }
    }
    const g = new GroupLike('grp');
    g.interactive = true;
    g.width = 100;
    g.height = 100;
    scene.add(g);

    (scene as any).syncA11y((scene as any).root);

    const swEl = (scene as any).a11yElements.get('sw') as HTMLElement;
    expect(swEl.getAttribute('tabindex')).toBe('0');

    let clicked = false;
    s.on('click', () => (clicked = true));

    // Simulate Enter keydown
    const event = new KeyboardEvent('keydown', { key: 'Enter' });
    Object.defineProperty(event, 'preventDefault', { value: vi.fn() });
    swEl.dispatchEvent(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(clicked).toBe(true);

    const grpEl = (scene as any).a11yElements.get('grp') as HTMLElement;
    expect(grpEl.hasAttribute('tabindex')).toBe(false);
  });
});

describe('Scene render loop: culling, onDemand, a11y early-out', () => {
  // A spy entity with controllable bounds; records render() calls.
  class SpyEntity extends Entity {
    public renders = 0;
    constructor(
      id: string,
      private bounds: { x: number; y: number; width: number; height: number } | null,
    ) {
      super(id);
    }
    getBounds() {
      return this.bounds;
    }
    isPointInside() {
      return false;
    }
    render() {
      this.renders++;
    }
  }

  // Stub rAF so loop()'s self-reschedule is a deterministic no-op.
  (globalThis as any).requestAnimationFrame = () => 0;

  function makeScene() {
    const parentDiv = document.createElement('div');
    const canvas = document.createElement('canvas');
    parentDiv.appendChild(canvas);
    const scene = new Scene(canvas); // window mock: 800x600 viewport
    (scene as any).isRunning = true; // allow loop() to run without scheduling
    return scene;
  }

  function tick(scene: Scene) {
    (scene as any).loop(performance.now());
  }

  it('culls a node whose world bounds are off-viewport', () => {
    const scene = makeScene();
    const onScreen = new SpyEntity('on', { x: 0, y: 0, width: 50, height: 50 }).setPosition(
      10,
      10,
    ) as SpyEntity;
    const offScreen = new SpyEntity('off', { x: 0, y: 0, width: 50, height: 50 }).setPosition(
      5000,
      5000,
    ) as SpyEntity;
    scene.add(onScreen);
    scene.add(offScreen);

    tick(scene);

    expect(onScreen.renders).toBe(1);
    expect(offScreen.renders).toBe(0); // culled
  });

  it('never culls a node with null bounds (default)', () => {
    const scene = makeScene();
    const noBounds = new SpyEntity('nb', null).setPosition(5000, 5000) as SpyEntity;
    scene.add(noBounds);

    tick(scene);

    expect(noBounds.renders).toBe(1);
  });

  it('onDemand mode skips render on idle non-dirty frames', () => {
    const scene = makeScene();
    scene.renderMode = 'onDemand';
    const e = new SpyEntity('e', null) as SpyEntity;
    scene.add(e);

    tick(scene); // first frame is dirty
    expect(e.renders).toBe(1);

    tick(scene); // idle, not dirty
    expect(e.renders).toBe(1);

    scene.markDirty();
    tick(scene); // dirty again
    expect(e.renders).toBe(2);
  });

  it('disableWindowResize keeps the canvas backing store at its own size', () => {
    const parentDiv = document.createElement('div');
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 300;
    parentDiv.appendChild(canvas);
    const scene = new Scene(canvas, { disableWindowResize: true });
    expect(scene.width).toBe(400);
    // CanvasRenderer used to clobber this to window.innerWidth (800 in this mock).
    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(300);
  });

  it('destroy() releases the WebGPU device', () => {
    const scene = makeScene();
    const destroy = vi.fn();
    (scene as any).device = { destroy };
    scene.destroy();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect((scene as any).device).toBeNull();
  });

  it('resize() keeps the WebGPU canvas backing store in step', () => {
    const scene = makeScene();
    (scene as any).renderer = {}; // the mock ctx can't service CanvasRenderer.resize
    const gpuCanvas = { width: 800, height: 600, style: {} };
    (scene as any).gpuCanvas = gpuCanvas;
    scene.resize(1024, 512);
    expect(gpuCanvas.width).toBe(1024);
    expect(gpuCanvas.height).toBe(512);
  });

  it('clears the GPU canvas once the last ComputeParticleEntity leaves', () => {
    const scene = makeScene();
    const submit = vi.fn();
    const pass = { end: vi.fn() };
    const encoder = { beginRenderPass: vi.fn(() => pass), finish: vi.fn(() => 'cmd') };
    (scene as any).device = { createCommandEncoder: () => encoder, queue: { submit } };
    (scene as any).gpuContext = { getCurrentTexture: () => ({ createView: () => ({}) }) };
    (scene as any).gpuHasContent = true; // particles were presented last frame

    tick(scene); // no ComputeParticleEntity in the tree anymore
    expect(submit).toHaveBeenCalledTimes(1); // one transparent clear pass
    expect((scene as any).gpuHasContent).toBe(false);

    scene.markDirty();
    tick(scene); // already clean — no second clear
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('onDemand skips idle frames even when autoThrottle is disabled', () => {
    const scene = makeScene();
    scene.renderMode = 'onDemand';
    scene.autoThrottle = false; // must not re-enable per-frame rendering
    const e = new SpyEntity('e', null) as SpyEntity;
    scene.add(e);

    tick(scene); // first frame is dirty
    expect(e.renders).toBe(1);

    tick(scene); // idle, not dirty — must still skip
    tick(scene);
    expect(e.renders).toBe(1);

    scene.markDirty();
    tick(scene);
    expect(e.renders).toBe(2);
  });

  it('onDemand mode keeps rendering while an animation is pending', () => {
    const scene = makeScene();
    scene.renderMode = 'onDemand';
    const e = new SpyEntity('e', null) as SpyEntity;
    e.animate({ opacity: 0 } as any, 1000);
    scene.add(e);

    tick(scene);
    tick(scene);
    expect(e.renders).toBe(2); // still rendering due to pending animation
  });

  it('markDirty() called inside update() survives to the next frame', () => {
    // The naive self-animating pattern: update() marks the scene dirty each
    // frame. The dirty flag must be consumed *before* the update/render pass,
    // otherwise marks made during update() are silently wiped at end of tick
    // and the entity freezes after one frame.
    class SelfDirtyEntity extends SpyEntity {
      public updates = 0;
      override update() {
        this.updates++;
        this.scene?.markDirty();
      }
    }
    const scene = makeScene();
    scene.renderMode = 'onDemand';
    const e = new SelfDirtyEntity('sd', null) as SelfDirtyEntity;
    scene.add(e);

    tick(scene); // frame 1: initial dirty
    tick(scene); // frame 2: dirty re-armed from inside update()
    tick(scene); // frame 3: same
    expect(e.renders).toBe(3);
    expect(e.updates).toBe(3);
  });

  it('markDirty() between frames still triggers exactly one onDemand render', () => {
    const scene = makeScene();
    scene.renderMode = 'onDemand';
    const e = new SpyEntity('e', null) as SpyEntity;
    scene.add(e);

    tick(scene); // initial dirty consumed
    scene.markDirty();
    tick(scene); // renders once
    tick(scene); // idle again — must skip
    expect(e.renders).toBe(2);
  });

  describe('CPU particle fallback coordinate space', () => {
    // One live perpetual particle at local (10, 20), size 4.
    function makeParticleEntity() {
      const e = new ComputeParticleEntity({ maxParticles: 1, size: 4 });
      e.setOrigins([10, 20]);
      e.particleData[6] = 4; // size (setOrigins does not populate it)
      e.particleData[7] = -1; // perpetual life
      return e;
    }

    it('GL point branch transforms particle positions to world space', () => {
      const scene = makeScene();
      const addCircle = vi.fn();
      (scene as any).pointRenderer = {
        addCircle,
        addRect: vi.fn(),
        begin: vi.fn(),
        flush: vi.fn(),
      };
      const e = makeParticleEntity();
      e.setPosition(100, 50);
      e.scaleX = 2;
      e.scaleY = 2;
      scene.add(e);

      tick(scene);

      expect(addCircle).toHaveBeenCalledTimes(1);
      const [x, y, size] = addCircle.mock.calls[0];
      // world = entity T*S applied to local (10, 20); size scaled by world scale
      expect(x).toBeCloseTo(100 + 2 * 10);
      expect(y).toBeCloseTo(50 + 2 * 20);
      expect(size).toBeCloseTo(4 * 2);
    });

    it('non-similarity transforms fall back to the canvas path (local space)', () => {
      const scene = makeScene();
      const addCircle = vi.fn();
      (scene as any).pointRenderer = {
        addCircle,
        addRect: vi.fn(),
        begin: vi.fn(),
        flush: vi.fn(),
      };
      const e = makeParticleEntity();
      e.scaleX = 2; // non-uniform: one radius cannot represent the ellipse
      e.scaleY = 1;
      scene.add(e);

      tick(scene);

      // Must not go through the GL point layer; the Canvas branch draws under
      // the entity's own transform instead.
      expect(addCircle).not.toHaveBeenCalled();
    });

    it('mouse repulsion compares the mouse in entity-local space', () => {
      const scene = makeScene();
      const e = makeParticleEntity();
      e.setPosition(500, 300); // far from origin so scene-space distance > 120
      // particle at local (10, 20) with origin there too → no spring force
      scene.add(e);
      // Scene-space mouse right next to the particle's world position (510, 325)
      (scene as any).mouseX = 510;
      (scene as any).mouseY = 322;

      tick(scene);

      // Local mouse (10, 22) is 2px from the particle (10, 20): repulsion must
      // push it away (negative y velocity). Comparing scene-space mouse to
      // local-space particles sees a ~580px distance and applies no force.
      expect(e.particleData[3]).toBeLessThan(0);
    });
  });

  it('clipChildren wraps the child render pass in a clip rect', () => {
    const scene = makeScene();
    mockCtx.clip.mockClear();
    const parent = new SpyEntity('clip-p', { x: 0, y: 0, width: 100, height: 80 }) as SpyEntity;
    parent.clipChildren = true;
    parent.width = 100;
    parent.height = 80;
    const child = new SpyEntity('clip-c', null) as SpyEntity;
    parent.add(child);
    scene.add(parent);

    tick(scene);

    expect(mockCtx.clip).toHaveBeenCalled();
    expect(child.renders).toBe(1); // child still rendered, just clipped
  });

  it('does not clip a normal (non-clipChildren) parent', () => {
    const scene = makeScene();
    mockCtx.clip.mockClear();
    const parent = new SpyEntity('noclip-p', null) as SpyEntity;
    parent.add(new SpyEntity('noclip-c', null));
    scene.add(parent);

    tick(scene);

    expect(mockCtx.clip).not.toHaveBeenCalled();
  });

  it('renders overlayRoot nodes unclipped even if main tree has clip regions', () => {
    const scene = makeScene();
    const parent = new (class TestEntity extends Entity {
      render(r: any) {
        r.clip(0, 0, 50, 50);
      }
    })('clipper');
    scene.add(parent);

    let renderedOverlay = false;
    const overlay = new (class TestOverlay extends Entity {
      render(_r: any) {
        renderedOverlay = true;
      }
    })('overlay');
    scene.showOverlay(overlay);

    // Trigger loop render
    (scene as any).loop(16);
    expect(renderedOverlay).toBe(true);
  });

  it('forwards wheel events from the shadow node to the entity', () => {
    const scene = makeScene();
    const e = new SpyEntity('wheel-e', { x: 0, y: 0, width: 100, height: 100 }) as SpyEntity;
    e.interactive = true;
    e.width = 100;
    e.height = 100;
    let wheels = 0;
    e.on('wheel', () => wheels++);
    scene.add(e);

    tick(scene); // mounts the shadow node + binds listeners
    const el = (scene as unknown as { a11yElements: Map<string, HTMLElement> }).a11yElements.get(
      'wheel-e',
    )!;
    expect(el).toBeTruthy();
    el.dispatchEvent(new Event('wheel'));

    expect(wheels).toBe(1);
  });

  function mountInteractive(scene: Scene, id: string): HTMLElement {
    const e = new SpyEntity(id, { x: 0, y: 0, width: 80, height: 80 }) as SpyEntity;
    e.interactive = true;
    e.width = 80;
    e.height = 80;
    scene.add(e);
    tick(scene);
    return (scene as unknown as { a11yElements: Map<string, HTMLElement> }).a11yElements.get(id)!;
  }

  it('sets touch-action:pinch-zoom on interactive shadow nodes (to allow pinch-zoom gesture)', () => {
    const scene = makeScene();
    const el = mountInteractive(scene, 'ta');
    expect(el.style.touchAction).toBe('pinch-zoom');
  });

  it('captures the pointer on pointerdown and releases it on pointerup', () => {
    const scene = makeScene();
    const el = mountInteractive(scene, 'cap');
    const captured: number[] = [];
    const released: number[] = [];
    el.setPointerCapture = (id: number) => captured.push(id);
    el.releasePointerCapture = (id: number) => released.push(id);

    el.dispatchEvent(Object.assign(new Event('pointerdown'), { pointerId: 7 }));
    el.dispatchEvent(Object.assign(new Event('pointerup'), { pointerId: 7 }));

    expect(captured).toEqual([7]);
    expect(released).toEqual([7]);
  });

  it('syncs the a11y shadow layer every frame by default', () => {
    const scene = makeScene();
    const e = new SpyEntity('s', { x: 0, y: 0, width: 50, height: 50 }) as SpyEntity;
    e.interactive = true;
    e.width = 50;
    e.height = 50;
    scene.add(e);
    const root = (scene as unknown as { root: Entity }).root;
    const spy = vi.spyOn(scene as unknown as { syncA11y: (n: Entity) => void }, 'syncA11y');
    const frames = () => spy.mock.calls.filter((c) => c[0] === root).length; // one root call per synced frame

    (scene as unknown as { loop: (t: number) => void }).loop(1000);
    (scene as unknown as { loop: (t: number) => void }).loop(1001);

    expect(frames()).toBe(2);
  });

  it('throttles the a11y shadow sync to a11ySyncInterval', () => {
    const scene = makeScene();
    scene.a11ySyncInterval = 100;
    const e = new SpyEntity('s2', { x: 0, y: 0, width: 50, height: 50 }) as SpyEntity;
    e.interactive = true;
    e.width = 50;
    e.height = 50;
    scene.add(e);
    const root = (scene as unknown as { root: Entity }).root;
    const spy = vi.spyOn(scene as unknown as { syncA11y: (n: Entity) => void }, 'syncA11y');
    const frames = () => spy.mock.calls.filter((c) => c[0] === root).length;

    const loop = (scene as unknown as { loop: (t: number) => void }).loop.bind(scene);
    loop(1000); // first frame → sync
    loop(1050); // +50ms, within interval → skipped
    loop(1200); // +200ms, past interval → sync

    expect(frames()).toBe(2);
  });
});

describe('Scene syncA11y — text input IME / selection / focus forwarding', () => {
  class InputLike extends Entity {
    constructor(
      id: string,
      private readonly a11yTag: 'input' | 'textarea' = 'input',
    ) {
      super(id);
    }

    isPointInside() {
      return false;
    }
    render() {}
    getA11yAttributes() {
      if (this.a11yTag === 'textarea') {
        return { tag: 'textarea' as const, value: 'abc', label: 'Notes' };
      }
      return { tag: 'input' as const, inputType: 'text', value: 'abc', label: 'Name' };
    }
  }

  function setup(a11yTag: 'input' | 'textarea' = 'input') {
    const parentDiv = document.createElement('div');
    const canvas = document.createElement('canvas');
    parentDiv.appendChild(canvas);
    const scene = new Scene(canvas);
    const e = new InputLike('inp', a11yTag);
    e.interactive = true;
    e.width = 100;
    e.height = 30;
    scene.add(e);
    (scene as any).syncA11y((scene as any).root);
    const el = (scene as any).a11yElements.get('inp') as HTMLInputElement;
    return { scene, e, el };
  }

  it('change payload carries selectionStart/selectionEnd', () => {
    const { e, el } = setup();
    const events: any[] = [];
    e.on('change', (p) => events.push(p));

    el.value = 'hello';
    el.setSelectionRange(2, 4);
    el.dispatchEvent(new Event('input'));

    expect(events.at(-1)).toMatchObject({ value: 'hello', selectionStart: 2, selectionEnd: 4 });
  });

  it('marks onDemand scenes dirty when form controls forward edits', () => {
    for (const tag of ['input', 'textarea'] as const) {
      const { scene, el } = setup(tag);
      scene.renderMode = 'onDemand';
      (scene as any).dirty = false;

      el.value = 'hello';
      el.dispatchEvent(new Event('input'));

      expect((scene as any).dirty).toBe(true);
    }
  });

  it('arrow-key/click caret moves are forwarded via selection', () => {
    const { e, el } = setup();
    const events: any[] = [];
    e.on('change', (p) => events.push(p));

    el.value = 'hello';
    el.setSelectionRange(3, 3);
    el.dispatchEvent(new Event('keyup'));
    expect(events.at(-1)).toMatchObject({ selectionStart: 3, selectionEnd: 3 });
  });

  it('composition lifecycle sets then clears the composition range', () => {
    const { e, el } = setup();
    const events: any[] = [];
    e.on('change', (p) => events.push(p));

    el.value = '';
    el.setSelectionRange(0, 0);
    el.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));

    el.value = '你好';
    el.setSelectionRange(2, 2);
    el.dispatchEvent(new CompositionEvent('compositionupdate', { data: '你好' }));
    expect(events.at(-1).composition).toEqual({ start: 0, length: 2 });

    el.dispatchEvent(new CompositionEvent('compositionend', { data: '你好' }));
    expect(events.at(-1).composition).toBeNull();
  });

  it('focus and blur emit on the entity', () => {
    const { e, el } = setup();
    let focused = 0;
    let blurred = 0;
    e.on('focus', () => focused++);
    e.on('blur', () => blurred++);

    el.dispatchEvent(new Event('focus'));
    el.dispatchEvent(new Event('blur'));

    expect(focused).toBe(1);
    expect(blurred).toBe(1);
  });
});

describe('Scene maxFPS / prefers-reduced-motion (power saving)', () => {
  class SpyEntity extends Entity {
    public renders = 0;
    isPointInside() {
      return false;
    }
    render() {
      this.renders++;
    }
  }

  (globalThis as any).requestAnimationFrame = () => 0;

  function makeScene(options: any = { maxFPS: 0 }) {
    const parentDiv = document.createElement('div');
    const canvas = document.createElement('canvas');
    parentDiv.appendChild(canvas);
    const scene = new Scene(canvas, options);
    (scene as any).isRunning = true;
    const spy = new SpyEntity('spy');
    scene.add(spy);
    return { scene, spy };
  }

  it('uncapped (maxFPS=0) renders on every frame', () => {
    const { scene, spy } = makeScene();
    (scene as any).lastTime = -1000;
    (scene as any).loop(0);
    (scene as any).loop(5);
    (scene as any).loop(10);
    expect(spy.renders).toBe(3);
  });

  it('maxFPS caps how often the scene renders', () => {
    const { scene, spy } = makeScene();
    scene.maxFPS = 30; // ~33.3ms interval
    (scene as any).lastTime = -1000;
    scene.markDirty();
    (scene as any).loop(0); // renders (renders=1), lastTime=0
    scene.markDirty();
    (scene as any).loop(10); // 10ms < 33.3 → skip
    scene.markDirty();
    (scene as any).loop(20); // skip
    scene.markDirty();
    (scene as any).loop(40); // 40ms ≥ interval → render (renders=2)
    expect(spy.renders).toBe(2);
  });

  it('accepts maxFPS via constructor options', () => {
    const parentDiv = document.createElement('div');
    const canvas = document.createElement('canvas');
    parentDiv.appendChild(canvas);
    const scene = new Scene(canvas, { maxFPS: 15 });
    expect(scene.maxFPS).toBe(15);
  });

  it('prefers-reduced-motion auto-caps an uncapped scene', () => {
    const prev = (globalThis as any).window.matchMedia;
    (globalThis as any).window.matchMedia = (q: string) => ({
      matches: q.includes('reduce'),
      addEventListener() {},
      removeEventListener() {},
    });
    try {
      const { scene, spy } = makeScene(); // maxFPS=0 but reduced-motion → ~30fps cap
      (scene as any).lastTime = -1000;
      (scene as any).loop(0); // renders=1
      (scene as any).loop(10); // < 33.3 → skip despite maxFPS=0
      expect(spy.renders).toBe(1);
    } finally {
      (globalThis as any).window.matchMedia = prev;
    }
  });

  it('respectReducedMotion=false ignores the media query', () => {
    const prev = (globalThis as any).window.matchMedia;
    (globalThis as any).window.matchMedia = (q: string) => ({
      matches: q.includes('reduce'),
      addEventListener() {},
      removeEventListener() {},
    });
    try {
      const parentDiv = document.createElement('div');
      const canvas = document.createElement('canvas');
      parentDiv.appendChild(canvas);
      const scene = new Scene(canvas, { respectReducedMotion: false });
      (scene as any).isRunning = true;
      const spy = new SpyEntity('spy');
      scene.add(spy);
      (scene as any).lastTime = -1000;
      (scene as any).loop(0);
      (scene as any).loop(10);
      expect(spy.renders).toBe(2); // not capped
    } finally {
      (globalThis as any).window.matchMedia = prev;
    }
  });
});

describe('Scene syncA11y — boundless / full-viewport interactive entities', () => {
  class Boundless extends Entity {
    constructor(id: string) {
      super(id);
      this.interactive = true;
      this.a11yFullViewport = true; // width/height stay 0
    }
    isPointInside() {
      return true;
    }
    render() {}
  }

  function makeScene() {
    const parentDiv = document.createElement('div');
    const canvas = document.createElement('canvas');
    parentDiv.appendChild(canvas);
    return new Scene(canvas);
  }

  it('mounts a shadow node for a width=0 entity when a11yFullViewport is set', () => {
    const scene = makeScene();
    const g = new Boundless('graph');
    scene.add(g);
    (scene as any).syncA11y((scene as any).root);
    const el = (scene as any).a11yElements.get('graph') as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.style.width).toBe('800px'); // window mock viewport
    expect(el.style.height).toBe('600px');
    expect(el.style.left).toBe('0px');
  });

  it('still skips a width=0 interactive entity without the flag', () => {
    const scene = makeScene();
    class Zero extends Entity {
      isPointInside() {
        return false;
      }
      render() {}
    }
    const z = new Zero('zero');
    z.interactive = true; // width stays 0, no flag
    scene.add(z);
    (scene as any).syncA11y((scene as any).root);
    expect((scene as any).a11yElements.get('zero')).toBeUndefined();
  });

  it('inserts the full-viewport node behind other shadow nodes', () => {
    const scene = makeScene();
    class Btn extends Entity {
      isPointInside() {
        return false;
      }
      render() {}
      getA11yAttributes() {
        return { tag: 'button' as const, label: 'Top' };
      }
    }
    const btn = new Btn('btn');
    btn.interactive = true;
    btn.width = 80;
    btn.height = 30;
    scene.add(btn); // added first
    const g = new Boundless('graph');
    scene.add(g); // added second, but must end up behind
    (scene as any).syncA11y((scene as any).root);
    const root = (scene as any).a11yRoot as HTMLElement;
    expect(root.firstChild).toBe((scene as any).a11yElements.get('graph'));
  });

  it('forwards pointermove from the full-viewport node to the entity', () => {
    const scene = makeScene();
    const g = new Boundless('graph');
    let moved = 0;
    g.on('pointermove', () => moved++);
    scene.add(g);
    (scene as any).syncA11y((scene as any).root);
    const el = (scene as any).a11yElements.get('graph') as HTMLElement;
    el.dispatchEvent(new Event('pointermove'));
    expect(moved).toBe(1);
  });
});

describe('Scene SSR / no-DOM safety', () => {
  // A minimal concrete entity for the SSR test.
  class Leaf extends Entity {
    isPointInside(): boolean {
      return false;
    }
    render(): void {}
  }

  it('constructs, ticks, and tears down without document / window / rAF', () => {
    const g = globalThis as unknown as {
      document?: unknown;
      window?: unknown;
      requestAnimationFrame?: unknown;
    };
    const savedDoc = g.document;
    const savedWin = g.window;
    const savedRaf = g.requestAnimationFrame;

    // A headless canvas: a working 2D context, but no surrounding DOM/window.
    const fakeCanvas = {
      getContext: () => mockCtx,
      width: 800,
      height: 600,
      style: { width: '', height: '' },
      parentElement: null,
    } as unknown as HTMLCanvasElement;

    try {
      g.document = undefined;
      g.window = undefined;
      g.requestAnimationFrame = undefined;

      let scene!: Scene;
      expect(() => {
        scene = new Scene(fakeCanvas);
      }).not.toThrow();
      // a11y projection degrades to a no-op (no DOM to mount into).
      expect((scene as unknown as { a11yRoot: unknown }).a11yRoot).toBeNull();

      const e = new Leaf('ssr');
      e.interactive = true;
      e.width = 10;
      e.height = 10;
      scene.add(e);

      // A full frame must not throw: render runs via the ctx, a11y no-ops,
      // and the next-frame schedule is skipped (no requestAnimationFrame).
      expect(() => (scene as unknown as { loop: (t: number) => void }).loop(0)).not.toThrow();
      expect(() => scene.destroy()).not.toThrow();
    } finally {
      g.document = savedDoc;
      g.window = savedWin;
      g.requestAnimationFrame = savedRaf;
    }
  });
});
