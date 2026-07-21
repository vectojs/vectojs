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
  measureText: vi.fn(() => ({
    width: 20,
    actualBoundingBoxAscent: 12,
    actualBoundingBoxDescent: 4,
  })),
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

  it('syncA11y clears optional native and ARIA state when attributes become undefined', () => {
    const parentDiv = document.createElement('div');
    const canvas = document.createElement('canvas');
    parentDiv.appendChild(canvas);
    const scene = new Scene(canvas);

    let enabled = false;
    class DynamicButton extends Entity {
      isPointInside() {
        return false;
      }
      render() {}
      getA11yAttributes(): A11yAttributes {
        return {
          tag: 'button',
          role: enabled ? undefined : 'button',
          label: enabled ? undefined : 'Undo',
          disabled: enabled ? undefined : true,
        };
      }
    }

    let detailed = true;
    class DynamicOption extends Entity {
      isPointInside() {
        return false;
      }
      render() {}
      getA11yAttributes(): A11yAttributes {
        return {
          role: 'option',
          checked: detailed ? true : undefined,
          expanded: detailed ? true : undefined,
          controls: detailed ? 'details' : undefined,
          haspopup: detailed ? 'menu' : undefined,
          selected: detailed ? true : undefined,
          activedescendant: detailed ? 'active' : undefined,
          valuemin: detailed ? '0' : undefined,
          valuemax: detailed ? '10' : undefined,
          value: detailed ? '4' : undefined,
        };
      }
    }

    const button = new DynamicButton('dynamic-button');
    const option = new DynamicOption('dynamic-option');
    for (const entity of [button, option]) {
      entity.interactive = true;
      entity.width = 40;
      entity.height = 20;
      scene.add(entity);
    }

    (scene as any).syncA11y((scene as any).root);
    const buttonElement = (scene as any).a11yElements.get(button.id) as HTMLButtonElement;
    const optionElement = (scene as any).a11yElements.get(option.id) as HTMLElement;
    expect(buttonElement.disabled).toBe(true);
    expect(buttonElement.getAttribute('role')).toBe('button');
    expect(buttonElement.getAttribute('aria-label')).toBe('Undo');
    expect(optionElement.getAttribute('aria-checked')).toBe('true');
    expect(optionElement.getAttribute('aria-expanded')).toBe('true');
    expect(optionElement.getAttribute('aria-controls')).toBe('details');
    expect(optionElement.getAttribute('aria-haspopup')).toBe('menu');
    expect(optionElement.getAttribute('aria-selected')).toBe('true');
    expect(optionElement.getAttribute('aria-activedescendant')).toBe('active');
    expect(optionElement.getAttribute('aria-valuemin')).toBe('0');
    expect(optionElement.getAttribute('aria-valuemax')).toBe('10');
    expect(optionElement.getAttribute('aria-valuenow')).toBe('4');

    enabled = true;
    detailed = false;
    (scene as any).syncA11y((scene as any).root);
    expect(buttonElement.disabled).toBe(false);
    expect(buttonElement.hasAttribute('role')).toBe(false);
    expect(buttonElement.hasAttribute('aria-label')).toBe(false);
    for (const name of [
      'aria-checked',
      'aria-expanded',
      'aria-controls',
      'aria-haspopup',
      'aria-selected',
      'aria-activedescendant',
      'aria-valuemin',
      'aria-valuemax',
      'aria-valuenow',
    ]) {
      expect(optionElement.hasAttribute(name)).toBe(false);
    }
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

  it('syncA11y honors and refreshes an explicit semantic tab index', () => {
    const parentDiv = document.createElement('div');
    const canvas = document.createElement('canvas');
    parentDiv.appendChild(canvas);
    const scene = new Scene(canvas);

    class FocusableRegion extends Entity {
      public semanticTabIndex: number | undefined = 0;
      isPointInside() {
        return false;
      }
      render() {}
      getA11yAttributes() {
        return { role: 'region', label: 'Canvas workspace', tabIndex: this.semanticTabIndex };
      }
    }
    const region = new FocusableRegion('focusable-region');
    region.interactive = true;
    region.width = 100;
    region.height = 100;
    scene.add(region);

    (scene as any).syncA11y((scene as any).root);
    const element = (scene as any).a11yElements.get(region.id) as HTMLElement;
    expect(element.getAttribute('tabindex')).toBe('0');

    region.semanticTabIndex = -1;
    (scene as any).syncA11y((scene as any).root);
    expect(element.getAttribute('tabindex')).toBe('-1');

    region.semanticTabIndex = undefined;
    (scene as any).syncA11y((scene as any).root);
    expect(element.hasAttribute('tabindex')).toBe(false);
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

  it('remounting an embedded Scene on the same canvas does not compound DPR scaling', () => {
    // SPA remount at DPR 2: after the first Scene, canvas.width holds the
    // DPR-scaled backing store (800 for a 400-logical canvas). A second Scene
    // reading canvas.width as the logical size would double every mount
    // (400 → 800 → 1600). The renderer records the logical size in the
    // canvas's inline style; subsequent Scenes must prefer it.
    const prevDPR = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    try {
      const parentDiv = document.createElement('div');
      const canvas = document.createElement('canvas');
      canvas.width = 400;
      canvas.height = 300;
      parentDiv.appendChild(canvas);

      const first = new Scene(canvas, { disableWindowResize: true });
      expect(first.width).toBe(400);
      expect(canvas.width).toBe(800); // backing store at DPR 2
      first.destroy();

      const second = new Scene(canvas, { disableWindowResize: true });
      expect(second.width).toBe(400); // NOT 800
      expect(canvas.width).toBe(800); // NOT 1600
      second.destroy();
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', { value: prevDPR, configurable: true });
    }
  });

  it('maxDPR caps the canvas backing store at construction (findings.md, 2026-07-16)', () => {
    const prevDPR = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: 3, configurable: true });
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 400;
      canvas.height = 300;
      const scene = new Scene(canvas, { disableWindowResize: true, maxDPR: 2 });
      expect(scene.width).toBe(400); // logical size unaffected
      expect(canvas.width).toBe(800); // 400 × 2 (capped), not × 3
      expect(canvas.height).toBe(600);
      scene.destroy();
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', { value: prevDPR, configurable: true });
    }
  });

  it('maxDPR is re-synced to the renderer on every resize(), not just at construction', () => {
    // This file's shared HTMLCanvasElement.prototype.getContext mock always
    // returns the SAME mockCtx object regardless of which canvas instance
    // calls it, and mockCtx has no `.canvas` back-reference — the same
    // limitation the neighboring "resize() keeps the WebGPU canvas backing
    // store in step" test works around by stubbing scene.renderer before
    // calling resize(). CanvasRenderer's own pixel-math correctness on
    // resize (with and without maxDPR) is already covered end-to-end in
    // CanvasRenderer.test.ts; what's specific to Scene here is that
    // Scene.resize() actually threads `this.maxDPR` onto the renderer
    // instance before delegating — assert that plumbing directly.
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 300;
    const scene = new Scene(canvas, { disableWindowResize: true, maxDPR: 2 });
    const renderer = (scene as any).renderer as { maxDPR?: number; resize: () => void };
    expect(renderer.maxDPR).toBe(2);
    renderer.resize = vi.fn(); // isolate: don't exercise CanvasRenderer's own resize math here
    // Change maxDPR AFTER construction so the assertion below can only pass
    // if resize() actually re-reads/re-syncs it — if resize() never touched
    // renderer.maxDPR, it would still read the construction-time value (2),
    // not the new one, and this would fail.
    scene.maxDPR = 1;
    scene.resize(500, 400);
    expect(renderer.maxDPR).toBe(1); // re-synced to the NEW value, not the construction-time one
    expect(renderer.resize).toHaveBeenCalledWith(500, 400);
    scene.destroy();
  });

  it('maxDPR undefined (default) leaves DPR handling uncapped, matching prior versions', () => {
    const prevDPR = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: 3, configurable: true });
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 400;
      canvas.height = 300;
      const scene = new Scene(canvas, { disableWindowResize: true });
      expect(canvas.width).toBe(1200); // 400 × 3, real DPR, uncapped
      scene.destroy();
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', { value: prevDPR, configurable: true });
    }
  });

  it('clientToScene mapping is DPR-independent for an embedded scene', () => {
    const prevDPR = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 400;
      canvas.height = 300;
      const scene = new Scene(canvas, { disableWindowResize: true });
      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
        left: 50,
        top: 20,
        width: 400, // CSS box = logical size
        height: 300,
        right: 450,
        bottom: 320,
        x: 50,
        y: 20,
        toJSON: () => ({}),
      });
      // Identity mapping: DPR must not leak into pointer→scene coordinates.
      expect(scene.clientToScene(250, 170)).toEqual({ x: 200, y: 150 });
      scene.destroy();
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', { value: prevDPR, configurable: true });
    }
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

  it('legacy animate() wakes an idle onDemand scene', () => {
    const scene = makeScene();
    scene.renderMode = 'onDemand';
    const e = new SpyEntity('wake', null) as SpyEntity;
    scene.add(e);
    tick(scene); // initial dirty consumed
    tick(scene); // fully idle
    expect(e.renders).toBe(1);

    e.animate({ opacity: 0 } as any, 200); // must wake the loop by itself
    tick(scene);
    expect(e.renders).toBe(2);
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

  describe('frameStats telemetry', () => {
    const loopAt = (scene: Scene, t: number) =>
      (scene as unknown as { loop: (t: number) => void }).loop(t);

    it('starts zeroed before any rendered frame', () => {
      const scene = makeScene();
      const s = scene.frameStats;
      expect(s.fps).toBe(0);
      expect(s.renderedFrames).toBe(0);
      expect(s.frameTimeMs).toBe(0);
      expect(s.renderMode).toBe('always');
    });

    it('counts rendered frames and derives fps from the rendered-frame interval', () => {
      const scene = makeScene();
      scene.maxFPS = 0; // uncapped, so fps reflects the raw interval
      scene.add(new SpyEntity('e', null));

      loopAt(scene, 1000); // first rendered frame (no interval yet)
      scene.markDirty();
      loopAt(scene, 1016); // +16ms → ~62.5 fps
      scene.markDirty();
      loopAt(scene, 1032); // +16ms

      const s = scene.frameStats;
      expect(s.renderedFrames).toBe(3);
      expect(s.fps).toBeGreaterThan(55);
      expect(s.fps).toBeLessThan(70);
      expect(s.frameIntervalMs).toBeGreaterThan(0);
    });

    it('clamps fps to maxFPS', () => {
      const scene = makeScene();
      scene.maxFPS = 30;
      scene.add(new SpyEntity('e', null));
      // Feed intervals well under the 30fps target; fps must not exceed the cap.
      loopAt(scene, 1000);
      for (let t = 1100; t <= 1500; t += 100) {
        scene.markDirty();
        loopAt(scene, t);
      }
      expect(scene.frameStats.fps).toBeLessThanOrEqual(30);
    });

    it('counts skipped frames in onDemand idle', () => {
      const scene = makeScene();
      scene.renderMode = 'onDemand';
      scene.maxFPS = 0;
      scene.add(new SpyEntity('e', null));

      loopAt(scene, 1000); // dirty → rendered
      loopAt(scene, 1016); // idle → skipped
      loopAt(scene, 1032); // idle → skipped

      const s = scene.frameStats;
      expect(s.renderedFrames).toBe(1);
      expect(s.skippedFrames).toBe(2);
      expect(s.renderMode).toBe('onDemand');
    });

    it('reflects the dirty flag', () => {
      const scene = makeScene();
      scene.maxFPS = 0;
      loopAt(scene, 1000); // consumes initial dirty
      expect(scene.frameStats.dirty).toBe(false);
      scene.markDirty();
      expect(scene.frameStats.dirty).toBe(true);
    });
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

  describe('static content projection', () => {
    class ContentEntity extends SpyEntity {
      public projText: string | null = 'Hello VectoJS';
      public projSelectable = false;
      public projContentX = 0;
      public projContentY = 0;
      constructor(id: string) {
        super(id, null);
        this.width = 200;
        this.height = 40;
      }
      override getContentProjection() {
        return this.projText === null
          ? null
          : {
              text: this.projText,
              font: '24px sans-serif',
              selectable: this.projSelectable,
              contentX: this.projContentX,
              contentY: this.projContentY,
            };
      }
    }

    function makeDomScene(options: Record<string, unknown> = {}) {
      const parentDiv = document.createElement('div');
      const canvas = document.createElement('canvas');
      parentDiv.appendChild(canvas);
      const scene = new Scene(canvas, options);
      (scene as any).isRunning = true;
      return scene;
    }

    function contentEl(scene: Scene, id: string): HTMLElement | undefined {
      return scene.getContentElement(id);
    }

    it('projects opt-in text as a transparent, findable DOM node', () => {
      const scene = makeDomScene();
      const e = new ContentEntity('txt');
      e.setPosition(30, 50);
      scene.add(e);

      tick(scene);

      const el = contentEl(scene, 'txt')!;
      expect(el).toBeDefined();
      expect(el.textContent).toBe('Hello VectoJS'); // real text — find-in-page/SEO see it
      expect(el.style.color).toBe('transparent'); // canvas owns the pixels
      expect(el.style.font).toContain('24px');
      expect(el.style.left).toBe('30px');
      expect(el.style.top).toBe('50px');
      expect(el.style.width).toBe('200px');
      expect(el.getAttribute('aria-hidden')).toBeNull(); // static text IS the SR content
      scene.destroy();
    });

    it('places projected text at its declared local content origin', () => {
      const scene = makeDomScene();
      const e = new ContentEntity('inset');
      e.setPosition(30, 50);
      e.projContentX = 18;
      e.projContentY = 12;
      scene.add(e);

      tick(scene);

      const el = contentEl(scene, 'inset')!;
      expect(el.style.left).toBe('48px');
      expect(el.style.top).toBe('62px');
      scene.destroy();
    });

    it('maps a projected local content origin through the entity transform', () => {
      const scene = makeDomScene();
      const e = new ContentEntity('scaled-inset');
      e.setPosition(30, 50);
      e.scaleX = 2;
      e.scaleY = 3;
      e.projContentX = 18;
      e.projContentY = 12;
      scene.add(e);

      tick(scene);

      const el = contentEl(scene, 'scaled-inset')!;
      // The visible glyph origin is a local point. Moving the root by an
      // unscaled inset makes its transparent selection surface diverge under
      // scale/rotation even when the untransformed case looks correct.
      expect(el.style.left).toBe('66px');
      expect(el.style.top).toBe('86px');
      scene.destroy();
    });

    it('marks the projection aria-hidden when the entity already has an interactive a11y node', () => {
      const scene = makeDomScene();
      const e = new ContentEntity('int');
      e.interactive = true;
      scene.add(e);

      tick(scene);

      expect(contentEl(scene, 'int')!.getAttribute('aria-hidden')).toBe('true');
      scene.destroy();
    });

    it('selectable gates pointer-events so canvas input is unaffected by default', () => {
      const scene = makeDomScene();
      const e = new ContentEntity('sel');
      scene.add(e);
      tick(scene);
      expect(contentEl(scene, 'sel')!.style.pointerEvents).toBe('none');

      e.projSelectable = true;
      tick(scene);
      const el = contentEl(scene, 'sel')!;
      expect(el.style.pointerEvents).toBe('auto');
      expect(el.style.userSelect).toBe('text');
      scene.destroy();
    });

    it('lets semantic containers opt out of pointer hit testing', () => {
      class SemanticContainer extends ContentEntity {
        override getA11yAttributes() {
          return { role: 'grid', pointerEvents: 'none' as const };
        }
      }

      const scene = makeDomScene();
      const container = new SemanticContainer('semantic-container');
      container.interactive = true;
      scene.add(container);
      tick(scene);

      expect(scene.getA11yElement(container.id)?.style.pointerEvents).toBe('none');
      scene.destroy();
    });

    it('keeps visual-line separators inside positioned line elements', () => {
      class MultilineContentEntity extends ContentEntity {
        override getContentProjection() {
          return {
            text: 'alpha beta\ngamma',
            font: '16px sans-serif',
            selectable: true,
            lines: [
              {
                text: 'alpha',
                x: 4,
                y: 6,
                baseline: 14,
                lineHeight: 20,
                separatorAfter: ' ',
              },
              {
                text: 'beta',
                x: 4,
                y: 26,
                baseline: 14,
                lineHeight: 20,
                separatorAfter: '\n',
              },
              { text: 'gamma', x: 4, y: 46, baseline: 14, lineHeight: 20 },
            ],
          };
        }
      }

      const scene = makeDomScene();
      scene.add(new MultilineContentEntity('multiline'));
      tick(scene);

      const root = contentEl(scene, 'multiline')!;
      expect(
        Array.from(root.childNodes).every((child) => child.nodeType === Node.ELEMENT_NODE),
      ).toBe(true);
      expect(Array.from(root.children).map((line) => line.textContent)).toEqual([
        'alpha ',
        'beta\n',
        'gamma',
      ]);
      expect(root.textContent).toBe('alpha beta\ngamma');
      scene.destroy();
    });

    it('keeps the legacy newline fallback inside each preceding line element', () => {
      class LegacyMultilineContentEntity extends ContentEntity {
        override getContentProjection() {
          return {
            text: 'first\nsecond',
            font: '16px sans-serif',
            lines: [
              { text: 'first', x: 0, y: 0, baseline: 14, lineHeight: 20 },
              { text: 'second', x: 0, y: 20, baseline: 14, lineHeight: 20 },
            ],
          };
        }
      }

      const scene = makeDomScene();
      scene.add(new LegacyMultilineContentEntity('legacy-multiline'));
      tick(scene);

      const root = contentEl(scene, 'legacy-multiline')!;
      expect(
        Array.from(root.childNodes).every((child) => child.nodeType === Node.ELEMENT_NODE),
      ).toBe(true);
      expect(Array.from(root.children).map((line) => line.textContent)).toEqual([
        'first\n',
        'second',
      ]);
      scene.destroy();
    });

    it('merges a run-based separator into the final run text node', () => {
      class RunContentEntity extends ContentEntity {
        override getContentProjection() {
          return {
            text: 'small large\nnext',
            font: '16px sans-serif',
            lines: [
              {
                text: 'small large',
                x: 0,
                y: 0,
                baseline: 14,
                lineHeight: 20,
                runs: [
                  { text: 'small ', font: '12px sans-serif' },
                  { text: 'large', font: '20px sans-serif' },
                ],
                separatorAfter: '\n',
              },
              { text: 'next', x: 0, y: 20, baseline: 14, lineHeight: 20 },
            ],
          };
        }
      }

      const scene = makeDomScene();
      scene.add(new RunContentEntity('run-multiline'));
      tick(scene);

      const firstLine = contentEl(scene, 'run-multiline')!.children[0] as HTMLElement;
      expect(firstLine.childNodes).toHaveLength(2);
      expect(firstLine.children[1].childNodes).toHaveLength(1);
      expect(firstLine.children[1].textContent).toBe('large\n');
      scene.destroy();
    });

    it('updates text in place and removes the node when projection goes null', () => {
      const scene = makeDomScene();
      const e = new ContentEntity('mut');
      scene.add(e);
      tick(scene);

      e.projText = 'changed';
      tick(scene);
      expect(contentEl(scene, 'mut')!.textContent).toBe('changed');

      e.projText = null;
      tick(scene);
      expect(contentEl(scene, 'mut')).toBeUndefined();
      scene.destroy();
    });

    it('keeps dynamically created content projections in VMT order', () => {
      const scene = makeDomScene();
      const first = new ContentEntity('first');
      const second = new ContentEntity('second');
      first.projText = null;
      second.projText = 'second';
      scene.add(first);
      scene.add(second);
      tick(scene);

      first.projText = 'first';
      tick(scene);

      const order = Array.from(
        ((scene as any).a11yRoot as HTMLElement).querySelectorAll<HTMLElement>(
          '[data-vecto-content]',
        ),
      ).map((element) => element.dataset.vectoContent);
      expect(order).toEqual(['first', 'second']);
      scene.destroy();
    });

    it('virtualizes far-off-viewport projections and re-materializes on return', () => {
      const scene = makeDomScene();
      const e = new ContentEntity('off');
      e.setPosition(5000, 5000); // far beyond the 800x600 viewport + 600px margin
      scene.add(e);
      tick(scene);
      // Beyond the virtualization margin: not materialized as DOM at all.
      expect(contentEl(scene, 'off')).toBeUndefined();

      e.setPosition(10, 10);
      scene.markDirty();
      tick(scene);
      // Back in view: materialized and visible.
      expect(contentEl(scene, 'off')!.style.display).not.toBe('none');
      scene.destroy();
    });

    it('materializes but hides near-off-viewport projections (within margin)', () => {
      const scene = makeDomScene();
      const e = new ContentEntity('near');
      e.setPosition(10, -60); // just above the top edge, within the 600px margin
      scene.add(e);
      tick(scene);
      const el = contentEl(scene, 'near');
      expect(el).toBeDefined(); // kept ready for scroll / selection
      expect(el!.style.display).toBe('none'); // but not shown (outside viewport)
      scene.destroy();
    });

    it('contentProjectionMargin: Infinity keeps the legacy materialize-everything behavior', () => {
      const scene = makeDomScene({ contentProjectionMargin: Infinity });
      const e = new ContentEntity('faraway');
      e.setPosition(5000, 5000);
      scene.add(e);
      tick(scene);
      const el = contentEl(scene, 'faraway');
      expect(el).toBeDefined(); // materialized despite being far off-screen
      expect(el!.style.display).toBe('none'); // hidden by the exact viewport test
      scene.destroy();
    });

    it('hides projections fully outside a clipChildren ancestor', () => {
      const scene = makeDomScene();
      const clip = new SpyEntity('clip', null);
      clip.width = 100;
      clip.height = 80;
      clip.clipChildren = true;
      const child = new ContentEntity('clipped');
      child.setPosition(120, 10);
      clip.add(child);
      scene.add(clip);
      tick(scene);

      expect(contentEl(scene, 'clipped')!.style.display).toBe('none');

      child.setPosition(20, 10);
      scene.markDirty();
      tick(scene);
      expect(contentEl(scene, 'clipped')!.style.display).not.toBe('none');
      scene.destroy();
    });

    it('contentProjection: false disables the layer entirely', () => {
      const scene = makeDomScene({ contentProjection: false });
      const e = new ContentEntity('nope');
      scene.add(e);
      tick(scene);
      expect(contentEl(scene, 'nope')).toBeUndefined();
      scene.destroy();
    });

    it('destroy() removes projected content nodes', () => {
      const parentDiv = document.createElement('div');
      const canvas = document.createElement('canvas');
      parentDiv.appendChild(canvas);
      document.body.appendChild(parentDiv);
      const scene = new Scene(canvas);
      (scene as any).isRunning = true;
      const e = new ContentEntity('gone');
      scene.add(e);
      tick(scene);
      const el = contentEl(scene, 'gone')!;
      expect(el.isConnected).toBe(true);
      scene.destroy();
      expect(el.isConnected).toBe(false);
      expect((scene as any).contentElements.size).toBe(0);
      parentDiv.remove();
    });

    it('removing a container prunes its descendants’ content projections', () => {
      const scene = makeDomScene();
      const container = new SpyEntity('wrap', null);
      const deep = new ContentEntity('deep');
      deep.projSelectable = true;
      container.add(deep);
      scene.add(container);
      tick(scene);

      const el = contentEl(scene, 'deep')!;
      expect(el).toBeDefined();
      expect(el.parentNode).not.toBeNull();

      // Entity.remove() → detachA11y must reach DESCENDANT projections too —
      // otherwise the transparent selectable node outlives the entity: it
      // keeps intercepting pointer input (pointer-events: auto) at its old
      // position, stays find-in-page-able, and leaks.
      scene.rootEntity.remove(container);
      tick(scene);

      expect(contentEl(scene, 'deep')).toBeUndefined();
      expect(el.parentNode).toBeNull();
      scene.destroy();
    });
  });

  it('exposes the scene-graph roots read-only for tooling', () => {
    const scene = makeScene();
    const e = new SpyEntity('tool-e', null);
    scene.add(e);
    expect(scene.rootEntity.children).toContain(e);
    expect(scene.overlayRootEntity.children).toEqual([]);
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

  it('assigns semantic stacking in the frame a new overlay is projected', () => {
    const scene = makeScene();
    const region = new SpyEntity('design-region', {
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
    region.interactive = true;
    region.width = 800;
    region.height = 600;
    scene.add(region);

    tick(scene);
    tick(scene);
    const regionElement = scene.getA11yElement(region.id)!;
    expect(regionElement.style.zIndex).not.toBe('');

    const backdrop = new SpyEntity('context-menu-backdrop', {
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
    backdrop.interactive = true;
    backdrop.width = 800;
    backdrop.height = 600;
    scene.showOverlay(backdrop);

    tick(scene);

    const backdropElement = scene.getA11yElement(backdrop.id)!;
    expect(backdropElement.style.zIndex).not.toBe('');
    expect(Number(backdropElement.style.zIndex)).toBeGreaterThan(
      Number(regionElement.style.zIndex),
    );
    scene.destroy();
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

  it('releases pointer capture and routes pointercancel to the projected entity', () => {
    const scene = makeScene();
    const entity = new SpyEntity('cancel', { x: 0, y: 0, width: 80, height: 80 }) as SpyEntity;
    entity.interactive = true;
    entity.width = 80;
    entity.height = 80;
    let canceled = 0;
    entity.on('pointercancel', () => canceled++);
    scene.add(entity);
    tick(scene);
    const el = (scene as unknown as { a11yElements: Map<string, HTMLElement> }).a11yElements.get(
      entity.id,
    )!;
    const captured: number[] = [];
    const released: number[] = [];
    el.setPointerCapture = (id: number) => captured.push(id);
    el.releasePointerCapture = (id: number) => released.push(id);

    el.dispatchEvent(Object.assign(new Event('pointerdown'), { pointerId: 11 }));
    el.dispatchEvent(Object.assign(new Event('pointercancel'), { pointerId: 11 }));

    expect(captured).toEqual([11]);
    expect(released).toEqual([11]);
    expect(canceled).toBe(1);
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

  describe('frame-pacing: dt quantization near the nominal interval', () => {
    class DtSpyEntity extends Entity {
      public dts: number[] = [];
      isPointInside() {
        return false;
      }
      render() {
        /* no-op */
      }
      override update(dt: number): void {
        this.dts.push(dt);
      }
    }

    function makeDtScene(maxFPS: number) {
      const parentDiv = document.createElement('div');
      const canvas = document.createElement('canvas');
      parentDiv.appendChild(canvas);
      const scene = new Scene(canvas, { maxFPS });
      (scene as any).isRunning = true;
      const spy = new DtSpyEntity('dt-spy');
      scene.add(spy);
      return { scene, spy };
    }

    it('snaps a jittery-but-close dt to the nominal 1000/cap interval', () => {
      const { scene, spy } = makeDtScene(60); // nominal = 16.667ms
      scene.markDirty();
      (scene as any).lastTime = 0;
      // Simulate 240Hz rAF jitter around the 60fps target: raw elapsed times
      // that hover near 16.667ms but never land exactly on it (the exact
      // failure mode a hard skip/render gate produces on a high-refresh
      // display — see forge/findings.md).
      const rawArrivals = [16.75, 33.62, 49.98, 66.9, 83.24, 99.61];
      for (const t of rawArrivals) {
        scene.markDirty();
        (scene as any).loop(t);
      }
      expect(spy.dts.length).toBeGreaterThan(0);
      for (const dt of spy.dts) {
        expect(dt).toBeCloseTo(1000 / 60, 5);
      }
    });

    it('does not quantize a genuine stall (dt far from nominal)', () => {
      const { scene, spy } = makeDtScene(60);
      scene.markDirty();
      (scene as any).lastTime = -1000;
      (scene as any).loop(0); // first frame, dt = 1000 (far from 16.667)
      expect(spy.dts[0]).toBe(1000);
      scene.markDirty();
      (scene as any).loop(500); // 500ms stall, dt = 500 — not snapped
      expect(spy.dts[1]).toBe(500);
    });

    it('uncapped (maxFPS=0) never quantizes dt', () => {
      const { scene, spy } = makeDtScene(0);
      scene.markDirty();
      (scene as any).lastTime = 0;
      (scene as any).loop(16.75);
      expect(spy.dts[0]).toBe(16.75); // raw, unmodified
    });
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
