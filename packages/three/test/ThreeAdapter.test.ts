// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ThreeAdapter } from '../src/ThreeAdapter';
import { Entity, VectoJSEvent } from '@vectojs/core';
import * as THREE from 'three';

// Mock WebGLRenderer & CanvasTexture to run in JSDOM headless environment
vi.mock('three', async () => {
  const actual = await vi.importActual<typeof import('three')>('three');

  class MockCanvasTexture {
    public needsUpdate = false;
    public version = 0;
    public minFilter = 0;
    public magFilter = 0;
    constructor(public image: any) {}
    dispose() {}
  }

  class MockMesh {
    parent: any = null;
    constructor(
      public geometry: any,
      public material: any,
    ) {}
  }

  return {
    ...actual,
    CanvasTexture: MockCanvasTexture as any,
    Mesh: MockMesh as any,
  };
});

describe('ThreeAdapter', () => {
  let adapter: ThreeAdapter;

  beforeEach(() => {
    // Stub getContext for HTMLCanvasElement in JSDOM
    HTMLCanvasElement.prototype.getContext = function () {
      return {
        scale: () => {},
        clearRect: () => {},
        save: () => {},
        restore: () => {},
        translate: () => {},
        rotate: () => {},
        clip: () => {},
        beginPath: () => {},
        rect: () => {},
        moveTo: () => {},
        lineTo: () => {},
        arc: () => {},
        fill: () => {},
        stroke: () => {},
        fillText: () => {},
        drawImage: () => {},
        measureText: () => ({ width: 100 }),
        canvas: this,
      } as any;
    } as any;

    adapter = new ThreeAdapter({ width: 800, height: 600 });
  });

  it('instantiates and creates the Vecto Scene and CanvasTexture', () => {
    expect(adapter).toBeDefined();
    expect(adapter.vectoScene).toBeDefined();
    expect(adapter.texture).toBeDefined();
    expect(adapter.texture.image).toBe(adapter.canvas);
    expect(adapter.canvas.width).toBe(800);
    expect(adapter.canvas.height).toBe(600);
  });

  it('custom resizes without clobbering window resize handler', () => {
    adapter.vectoScene.resize(1024, 768);
    expect(adapter.vectoScene.width).toBe(1024);
    expect(adapter.vectoScene.height).toBe(768);
  });

  it('marks texture as dirty only when VectoScene actually renders', () => {
    adapter.texture.needsUpdate = false;

    // Triggering a render cycle (using renderMode = 'always' or manually invoking)
    adapter.vectoScene.render(adapter.vectoScene.getRenderer(), 16, 16);
    expect(adapter.texture.needsUpdate).toBe(true);
  });

  it('translates UV hit coordinates into Canvas pixel coordinates', () => {
    let capturedEvent: PointerEvent | null = null;
    adapter.canvas.addEventListener('pointerdown', (e: any) => {
      capturedEvent = e;
    });

    // Mock a ThreeJS Raycaster intersection hit
    const mockRaycaster = {
      intersectObject: () => [
        {
          uv: new THREE.Vector2(0.5, 0.25), // UV coordinates
        },
      ],
    } as any;

    const hit = adapter.updateIntersection(mockRaycaster, 'pointerdown');
    expect(hit).toBe(true);
    expect(capturedEvent).not.toBeNull();

    // Three.js UV origin is bottom-left, Canvas origin is top-left
    // x = 0.5 * 800 = 400
    // y = (1.0 - 0.25) * 600 = 450
    expect(capturedEvent!.clientX).toBe(400);
    expect(capturedEvent!.clientY).toBe(450);
  });

  it('triggers pointerleave event when pointer exits mesh boundary', () => {
    let leaveCaptured = false;
    adapter.canvas.addEventListener('pointerleave', () => {
      leaveCaptured = true;
    });

    const mockRaycaster = {
      intersectObject: () => [
        {
          uv: new THREE.Vector2(0.5, 0.5),
        },
      ],
    } as any;

    // 1st pointermove intersects the mesh
    adapter.updateIntersection(mockRaycaster, 'pointermove');

    // 2nd pointermove does not intersect (raycaster returns empty)
    const mockRaycasterOut = {
      intersectObject: () => [],
    } as any;

    const hit = adapter.updateIntersection(mockRaycasterOut, 'pointermove');
    expect(hit).toBe(false);
    expect(leaveCaptured).toBe(true);
  });

  it('falls back to direct entity dispatch for a11y elements that exist but are DOM-detached (ThreeAdapter always produces these)', () => {
    // ThreeAdapter's canvas is offscreen and never inserted into a live document
    // (that's the whole point — it's rendered into a texture, not shown directly),
    // so `canvas.parentElement` is never truthy and a11yRoot is never attached to
    // `document` (Scene.ts's a11yRoot-append guard). syncA11y still creates and
    // populates individual a11y elements as children of that detached a11yRoot —
    // getA11yElement() legitimately returns a real, non-null Element — but neither
    // it nor a11yRoot is ever `.isConnected`. Native DOM APIs some UI components'
    // internals rely on (setPointerCapture, robust focus()) require a connected
    // element and throw otherwise, so dispatchEventToTarget must route through the
    // same fallback used when no a11y element exists at all, not attempt a DOM
    // dispatch a disconnected element can't safely receive.
    class TestInput extends Entity {
      isPointInside(x: number, y: number) {
        return x >= 100 && x <= 200 && y >= 100 && y <= 200;
      }
      render() {}
      getA11yAttributes() {
        return { role: 'textbox', value: 'hello' };
      }
    }

    const testInput = new TestInput('input-node').setPosition(150, 150);
    testInput.interactive = true;
    testInput.width = 100;
    testInput.height = 100;
    adapter.vectoScene.add(testInput);

    // Run layout and sync a11y DOM
    adapter.vectoScene.render(adapter.vectoScene.getRenderer(), 16, 16);
    (adapter.vectoScene as any).syncA11y((adapter.vectoScene as any).root);

    const a11yEl = adapter.vectoScene.getA11yElement('input-node');
    expect(a11yEl).toBeDefined();
    // The premise this test exists to cover: a real element that is NOT connected
    // to a live document — exactly ThreeAdapter's permanent, by-design situation.
    expect(a11yEl!.isConnected).toBe(false);

    let a11yEventDispatched = false;
    a11yEl!.addEventListener('pointerdown', () => {
      a11yEventDispatched = true;
    });

    let bubbleEvent: VectoJSEvent | null = null;
    testInput.on('pointerdown', (e: any) => {
      bubbleEvent = e;
    });

    // Simulate clicking on the input node (pixel coords: x=150, y=150)
    // UV: x = 150/800 = 0.1875, y = 1.0 - 150/600 = 0.75
    const mockRaycaster = {
      intersectObject: () => [
        {
          uv: new THREE.Vector2(0.1875, 0.75),
        },
      ],
    } as any;

    adapter.updateIntersection(mockRaycaster, 'pointerdown');

    // Detached a11y element receives nothing; the entity's own VectoJSEvent
    // dispatch fires instead — the same fallback path used for entities with no
    // a11y element at all.
    expect(a11yEventDispatched).toBe(false);
    expect(bubbleEvent).not.toBeNull();
    expect(bubbleEvent!.type).toBe('pointerdown');
  });

  it('bubbles events directly in Vecto tree if entity has no DOM element', () => {
    class NormalShape extends Entity {
      isPointInside(x: number, y: number) {
        return x >= 100 && x <= 200 && y >= 100 && y <= 200;
      }
      render() {}
    }

    const shape = new NormalShape('shape-node').setPosition(150, 150);
    shape.width = 100;
    shape.height = 100;
    adapter.vectoScene.add(shape);

    let bubbleEvent: VectoJSEvent | null = null;
    shape.on('pointerdown', (e: any) => {
      bubbleEvent = e;
    });

    const mockRaycaster = {
      intersectObject: () => [
        {
          uv: new THREE.Vector2(0.1875, 0.75),
        },
      ],
    } as any;

    adapter.updateIntersection(mockRaycaster, 'pointerdown');
    expect(bubbleEvent).not.toBeNull();
    expect(bubbleEvent!.type).toBe('pointerdown');
  });

  it('maps UV hits to logical scene coordinates, not DPR-scaled canvas pixels', () => {
    // On a HiDPI display, core's CanvasRenderer scales the canvas backing store
    // (canvas.width = logicalWidth * devicePixelRatio) and ctx.scale()s so all
    // drawing and entity layout stay in logical coordinates. UV -> pixel mapping
    // must therefore use the Scene's logical dimensions -- multiplying by the
    // physical canvas.width instead shifts every hit down/right by exactly the
    // DPR factor (at DPR=2, clicking one control activates the control ~2x
    // further down the panel). Regression test for the Dimension-demo mis-click
    // reports; invisible at DPR=1 where physical == logical.
    const original = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    try {
      const hidpi = new ThreeAdapter({ width: 800, height: 600 });
      // Premise: the renderer really did scale the backing store 2x, while the
      // scene's logical viewport stayed at the requested size.
      expect(hidpi.canvas.width).toBe(1600);
      expect(hidpi.vectoScene.width).toBe(800);

      class Shape extends Entity {
        isPointInside(x: number, y: number) {
          return x >= 100 && x <= 200 && y >= 100 && y <= 200;
        }
        render() {}
      }
      const shape = new Shape('hidpi-shape').setPosition(150, 150);
      shape.width = 100;
      shape.height = 100;
      hidpi.vectoScene.add(shape);

      let received: VectoJSEvent | null = null;
      shape.on('pointerdown', (e: any) => {
        received = e;
      });

      // UV for logical (150, 150) in the 800x600 scene: (150/800, 1 - 150/600).
      const mockRaycaster = {
        intersectObject: () => [{ uv: new THREE.Vector2(0.1875, 0.75) }],
      } as any;

      hidpi.updateIntersection(mockRaycaster, 'pointerdown');
      expect(received).not.toBeNull();
      expect(received!.type).toBe('pointerdown');
    } finally {
      if (original) Object.defineProperty(window, 'devicePixelRatio', original);
    }
  });

  it('isolates state per pointerId to support multi-pointer/touch', () => {
    const mockRaycaster1 = {
      intersectObject: () => [
        {
          uv: new THREE.Vector2(0.1, 0.1),
        },
      ],
    } as any;

    const mockRaycaster2 = {
      intersectObject: () => [
        {
          uv: new THREE.Vector2(0.9, 0.9),
        },
      ],
    } as any;

    // Simulate pointer 1 (id: 10) hovering on bottom-left
    const pe1 = new PointerEvent('pointermove', { pointerId: 10 });
    adapter.updateIntersection(mockRaycaster1, 'pointermove', pe1);

    // Simulate pointer 2 (id: 20) hovering on top-right
    const pe2 = new PointerEvent('pointermove', { pointerId: 20 });
    adapter.updateIntersection(mockRaycaster2, 'pointermove', pe2);

    const state1 = (adapter as any).activePointers.get(10);
    const state2 = (adapter as any).activePointers.get(20);

    expect(state1.isHovering).toBe(true);
    expect(state2.isHovering).toBe(true);
    expect(state1.lastUv.x).toBeCloseTo(0.1);
    expect(state2.lastUv.x).toBeCloseTo(0.9);
  });

  it('handles click events and dispatches them correctly', () => {
    let clicked = false;
    adapter.canvas.addEventListener('click', () => {
      clicked = true;
    });

    const mockRaycaster = {
      intersectObject: () => [{ uv: new THREE.Vector2(0.5, 0.5) }],
    } as any;

    adapter.updateIntersection(mockRaycaster, 'click');
    expect(clicked).toBe(true);
  });

  it('handles wheel events with delta fallback', () => {
    let deltaYCaptured = -1;
    adapter.canvas.addEventListener('wheel', (e: any) => {
      deltaYCaptured = e.deltaY;
    });

    const mockRaycaster = {
      intersectObject: () => [{ uv: new THREE.Vector2(0.5, 0.5) }],
    } as any;

    // Dispatch wheel event without originalEvent
    adapter.updateIntersection(mockRaycaster, 'wheel');
    expect(deltaYCaptured).toBe(0);
  });

  it('resets canvas and scene dimensions via resize method', () => {
    adapter.resize(1920, 1080);
    expect(adapter.canvas.width).toBe(1920);
    expect(adapter.canvas.height).toBe(1080);
    expect(adapter.vectoScene.width).toBe(1920);
    expect(adapter.vectoScene.height).toBe(1080);
    expect(adapter.texture.needsUpdate).toBe(true);
  });

  it('detaches mesh and disposes all resources cleanly', () => {
    const parentMock = {
      remove: vi.fn(),
    };
    adapter.mesh.parent = parentMock as any;

    const textureDisposeSpy = vi.spyOn(adapter.texture, 'dispose');
    const sceneDestroyRealSpy = vi.spyOn(adapter.vectoScene, 'destroy');

    adapter.dispose();

    expect(textureDisposeSpy).toHaveBeenCalledOnce();
    expect(sceneDestroyRealSpy).toHaveBeenCalledOnce();
    expect(parentMock.remove).toHaveBeenCalledWith(adapter.mesh);
    expect(adapter.canvas.width).toBe(0);
    expect(adapter.canvas.height).toBe(0);
  });
});
