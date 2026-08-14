// @vitest-environment jsdom
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { GraphCamera } from '../src/GraphCamera';

const makeDom = (w = 400, h = 300) => {
  const el = document.createElement('canvas');
  Object.defineProperty(el, 'clientWidth', { value: w, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: h, configurable: true });
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  return el;
};

const pointer = (type: string, x: number, y: number, button = 0): PointerEvent => {
  const ev = new Event(type, { bubbles: true }) as PointerEvent;
  Object.assign(ev, { clientX: x, clientY: y, button, pointerId: 1 });
  return ev;
};

describe('GraphCamera', () => {
  it('defaults to a 2D orthographic camera looking down -Z', () => {
    const cam = new GraphCamera({ domElement: makeDom() });
    expect(cam.getMode()).toBe('2d');
    expect(cam.camera).toBeInstanceOf(THREE.OrthographicCamera);
    const o = cam.camera as THREE.OrthographicCamera;
    expect(o.position.z).toBeGreaterThan(0);
    // Looking toward origin: forward is roughly -Z.
    const dir = new THREE.Vector3();
    o.getWorldDirection(dir);
    expect(dir.z).toBeLessThan(0);
    cam.dispose();
  });

  it('switches to a perspective camera in 3D mode', () => {
    const cam = new GraphCamera({ domElement: makeDom(), mode: '3d' });
    expect(cam.camera).toBeInstanceOf(THREE.PerspectiveCamera);
    cam.setMode('2d');
    expect(cam.camera).toBeInstanceOf(THREE.OrthographicCamera);
    cam.setMode('3d');
    expect(cam.camera).toBeInstanceOf(THREE.PerspectiveCamera);
    cam.dispose();
  });

  it('pans the orthographic view on left-drag in 2D', () => {
    const cam = new GraphCamera({ domElement: makeDom() });
    const o = cam.camera as THREE.OrthographicCamera;
    const x0 = o.position.x;
    const el = cam['domElement'] as HTMLElement;
    el.dispatchEvent(pointer('pointerdown', 100, 100, 0));
    el.dispatchEvent(pointer('pointermove', 140, 100, 0));
    el.dispatchEvent(pointer('pointerup', 140, 100, 0));
    // Dragging right should move the world left (camera +target.x decreases content under cursor).
    expect(o.position.x).not.toBe(x0);
    cam.dispose();
  });

  it('zooms the orthographic camera on wheel', () => {
    const cam = new GraphCamera({ domElement: makeDom() });
    const o = cam.camera as THREE.OrthographicCamera;
    const z0 = o.zoom;
    const wheel = new Event('wheel', { bubbles: true }) as WheelEvent;
    Object.assign(wheel, {
      deltaY: -120,
      clientX: 200,
      clientY: 150,
      preventDefault: vi.fn(),
    });
    (cam['domElement'] as HTMLElement).dispatchEvent(wheel);
    expect(o.zoom).toBeGreaterThan(z0);
    cam.dispose();
  });

  it('does not bake zoom into the ortho frustum (no double-zoom)', () => {
    // Regression: setSize used to divide left/right/top/bottom by zoom while
    // Three also divides by camera.zoom → visible extent ∝ 1/zoom² and the
    // graph vanished after a few wheel steps.
    const cam = new GraphCamera({
      domElement: makeDom(400, 300),
      width: 400,
      height: 300,
      orthoHalfHeight: 200,
    });
    const o = cam.camera as THREE.OrthographicCamera;
    const baseHalfW = o.right; // unzoomed
    const wheel = new Event('wheel', { bubbles: true }) as WheelEvent;
    Object.assign(wheel, {
      deltaY: -400,
      clientX: 200,
      clientY: 150,
      preventDefault: vi.fn(),
    });
    (cam['domElement'] as HTMLElement).dispatchEvent(wheel);
    // Frustum edges stay at the base half-extent; only camera.zoom changes.
    expect(o.right).toBeCloseTo(baseHalfW, 5);
    expect(o.top).toBeCloseTo(200, 5);
    expect(o.zoom).toBeGreaterThan(1);
    // Effective visible half-height is base/zoom, not base/zoom².
    const visibleHalfH = o.top / o.zoom;
    expect(visibleHalfH).toBeCloseTo(200 / o.zoom, 5);
    cam.dispose();
  });

  it('setEnabled(false) ignores pointer and wheel', () => {
    const cam = new GraphCamera({ domElement: makeDom() });
    const o = cam.camera as THREE.OrthographicCamera;
    const x0 = o.position.x;
    const z0 = o.zoom;
    cam.setEnabled(false);
    const el = cam['domElement'] as HTMLElement;
    el.dispatchEvent(pointer('pointerdown', 100, 100, 0));
    el.dispatchEvent(pointer('pointermove', 180, 100, 0));
    el.dispatchEvent(pointer('pointerup', 180, 100, 0));
    const wheel = new Event('wheel', { bubbles: true }) as WheelEvent;
    Object.assign(wheel, { deltaY: -200, preventDefault: vi.fn() });
    el.dispatchEvent(wheel);
    expect(o.position.x).toBe(x0);
    expect(o.zoom).toBe(z0);
    cam.dispose();
  });

  it('fitToPositions centers the target on the AABB mid-point', () => {
    const cam = new GraphCamera({ domElement: makeDom() });
    // Bounds: x∈[0,20], y∈[0,20] → center (10, 10)
    const pos = new Float32Array([0, 20, 0, 20, 20, 0, 10, 0, 0]);
    cam.fitToPositions(pos);
    const o = cam.camera as THREE.OrthographicCamera;
    expect(o.position.x).toBeCloseTo(10, 5);
    expect(o.position.y).toBeCloseTo(10, 5);
    cam.dispose();
  });

  it('setSize updates the orthographic aspect', () => {
    const cam = new GraphCamera({ domElement: makeDom(200, 200) });
    const o = cam.camera as THREE.OrthographicCamera;
    const before = o.right - o.left;
    cam.setSize(400, 200);
    const after = o.right - o.left;
    expect(after).toBeGreaterThan(before);
    cam.dispose();
  });

  it('dispose removes listeners so later events are ignored', () => {
    const cam = new GraphCamera({ domElement: makeDom() });
    const o = cam.camera as THREE.OrthographicCamera;
    const z0 = o.zoom;
    cam.dispose();
    const wheel = new Event('wheel', { bubbles: true }) as WheelEvent;
    Object.assign(wheel, { deltaY: -500, preventDefault: vi.fn() });
    (cam['domElement'] as HTMLElement).dispatchEvent(wheel);
    expect(o.zoom).toBe(z0);
  });
});
