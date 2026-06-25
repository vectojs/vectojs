// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

// Scene requires a real canvas, so we mock the DOM
const mockCtx = {
  scale: vi.fn(),
  clearRect: vi.fn(),
  save: vi.fn(),
  restore: vi.fn(),
  translate: vi.fn(),
  fillText: vi.fn(),
  beginPath: vi.fn(),
  fill: vi.fn(),
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
