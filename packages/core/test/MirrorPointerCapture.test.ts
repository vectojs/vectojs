// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Scene, Entity, A11yAttributes } from '../src';

class Hotspot extends Entity {
  constructor(
    id: string,
    private readonly role: string,
    parent?: Entity,
  ) {
    super(id);
    this.interactive = true;
    this.width = 200;
    this.height = 60;
    if (parent) parent.add(this);
  }

  isPointInside() {
    return false;
  }

  render() {}

  public getA11yAttributes(): A11yAttributes {
    return { role: this.role, label: this.id };
  }
}

function fakeCtx(): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'measureText') return (t: string) => ({ width: t.length * 8 });
        if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
        if (prop === 'canvas') return { width: 0, height: 0, style: {} };
        return () => {};
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
}

describe('mirror pointerdown capture guard', () => {
  let canvas: HTMLCanvasElement;
  let scene: Scene;

  const tick = () => {
    (scene as any).isRunning = true;
    (scene as any).loop(0);
  };

  beforeEach(() => {
    const ctx = fakeCtx();
    HTMLCanvasElement.prototype.getContext = (() => ctx) as never;
    canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    document.body.appendChild(canvas);
    scene = new Scene(canvas, { maxFPS: 0 });
    scene.renderMode = 'always';
  });

  afterEach(() => {
    scene.destroy();
    canvas.remove();
  });

  it('does not re-capture a bubbled pointerdown on an ancestor mirror', () => {
    // The live Dropdown shape: a listbox container owning option leaves.
    const parent = new Hotspot('container', 'listbox');
    scene.add(parent);
    tick();
    new Hotspot('leaf', 'option', parent);
    tick();

    const containerEl = scene.getA11yElement('container');
    const leafEl = scene.getA11yElement('leaf');
    expect(containerEl).toBeTruthy();
    expect(leafEl).toBeTruthy();
    // The leaf's mirror must actually nest inside the container's for the
    // bubbled dispatch below to cross it.
    expect(containerEl!.contains(leafEl!)).toBe(true);

    const captureContainer = vi.fn();
    const captureLeaf = vi.fn();
    (containerEl as any).setPointerCapture = captureContainer;
    (leafEl as any).setPointerCapture = captureLeaf;

    // A real click dispatches natively on the deepest hit-testable element and
    // bubbles through every projected ancestor. The ancestor must not override
    // the child's pending capture, or the browser retargets pointerup + click
    // to their common ancestor (measured live: Dropdown menu options landed on
    // their listbox container and selection silently died).
    leafEl!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));

    expect(captureLeaf).toHaveBeenCalledTimes(1);
    expect(captureContainer).not.toHaveBeenCalled();

    // A direct hit on the container itself still captures.
    containerEl!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(captureContainer).toHaveBeenCalledTimes(1);
  });
});
