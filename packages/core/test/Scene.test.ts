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
  fill: vi.fn(),
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

import { Scene } from '../src/tree/Scene';
import { Entity } from '../src/tree/Entity';

// Entity is abstract; use a minimal concrete subclass for tests.
class TestEntity extends Entity {
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

describe('Scene', () => {
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
});
