// @vitest-environment jsdom
// `inspectAccelerators` turns Scene.accelerators into a verdict. The value is in
// the classification: a developer reading `animBackend === 'wasm'` concludes the
// accelerator is doing work, when a shut gate means every driver ticked in JS.
// These tests pin that the audit fires ONLY on a real fault, because an audit
// that warns about normal operation teaches people to ignore it.
import { describe, it, expect, vi } from 'vitest';
import { Scene, Entity } from '@vectojs/core';
import {
  auditAccelerators,
  formatAcceleratorInspection,
  inspectAccelerators,
} from '../src/acceleratorInspect';

class Box extends Entity {
  constructor(id: string) {
    super(id);
    this.width = 30;
    this.height = 30;
  }
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

function makeScene(): Scene {
  (globalThis as { window?: unknown }).window = {
    innerWidth: 300,
    innerHeight: 200,
    devicePixelRatio: 1,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const ctx = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'measureText') return (t: string) => ({ width: String(t).length * 8 });
        if (prop === 'canvas') return { width: 300, height: 200, style: {} };
        return () => {};
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
  HTMLCanvasElement.prototype.getContext = (() => ctx) as never;
  const canvas = document.createElement('canvas');
  canvas.width = 300;
  canvas.height = 200;
  const scene = new Scene(canvas, { disableWindowResize: true });
  scene.resize(300, 200);
  return scene;
}

describe('inspectAccelerators', () => {
  it('reports all four accelerators in a stable order', () => {
    const scene = makeScene();
    const info = inspectAccelerators(scene);
    expect(info.accelerators.map((a) => a.accelerator)).toEqual([
      'transform',
      'animation',
      'hitTest',
      'particle',
    ]);
    scene.destroy();
  });

  it('says the scene runs on JS rather than implying an accelerated one', () => {
    const scene = makeScene();
    scene.add(new Box('a'));
    const info = inspectAccelerators(scene);
    expect(info.availableCount).toBe(0);
    expect(info.activeCount).toBe(0);
    expect(info.summary).toMatch(/no accelerators installed/i);
    // Nothing faulted: absent is not broken.
    expect(info.faulted).toEqual([]);
    expect(auditAccelerators(scene)).toEqual([]);
    scene.destroy();
  });

  it('explains a not-installed accelerator with what to do about it', () => {
    const scene = makeScene();
    const info = inspectAccelerators(scene);
    const transform = info.accelerators.find((a) => a.accelerator === 'transform')!;
    expect(transform.available).toBe(false);
    expect(transform.reason).toBe('not-installed');
    expect(transform.explanation).toMatch(/enableWasm/i);
    scene.destroy();
  });

  it('does not fault a shut gate', () => {
    const scene = makeScene();
    // Simulate the reporting case that motivated this: installed, deliberately
    // not used this frame because the workload is below break-even.
    const stub = {
      transform: {
        available: true,
        activeThisFrame: false,
        reason: 'below-gate',
        path: 'js',
      },
      animation: {
        available: true,
        activeThisFrame: false,
        reason: 'below-gate',
        path: 'js',
      },
      hitTest: {
        available: false,
        activeThisFrame: false,
        reason: 'not-installed',
        path: 'js',
      },
      particle: {
        available: false,
        activeThisFrame: false,
        reason: 'not-applicable',
        path: 'none',
      },
    };
    Object.defineProperty(scene, 'accelerators', { get: () => stub });

    const info = inspectAccelerators(scene);
    expect(info.faulted).toEqual([]);
    expect(auditAccelerators(scene)).toEqual([]);
    // The summary must make "installed but idle" unmistakable, since that is
    // exactly the state people misread as accelerated.
    expect(info.summary).toMatch(/none active/i);
    const below = info.accelerators.find((a) => a.accelerator === 'animation')!;
    expect(below.explanation).toMatch(/working as designed/i);
    scene.destroy();
  });

  it('faults a rejected kernel and says it is a fault', () => {
    const scene = makeScene();
    const stub = {
      transform: {
        available: true,
        activeThisFrame: false,
        reason: 'rejected',
        path: 'js',
      },
      animation: {
        available: true,
        activeThisFrame: true,
        reason: 'active',
        path: 'wasm',
      },
      hitTest: {
        available: false,
        activeThisFrame: false,
        reason: 'not-installed',
        path: 'js',
      },
      particle: {
        available: false,
        activeThisFrame: false,
        reason: 'not-applicable',
        path: 'none',
      },
    };
    Object.defineProperty(scene, 'accelerators', { get: () => stub });

    const info = inspectAccelerators(scene);
    expect(info.faulted.map((a) => a.accelerator)).toEqual(['transform']);
    expect(info.summary).toMatch(/FAULTED/);
    expect(info.accelerators[0].explanation).toMatch(/fault/i);

    const findings = auditAccelerators(scene);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('accelerator-rejected');
    expect(findings[0].severity).toBe('warn');
    expect(findings[0].message).toMatch(/refused the call/i);
    scene.destroy();
  });

  it('names which accelerators ran, and on what', () => {
    const scene = makeScene();
    const stub = {
      transform: {
        available: true,
        activeThisFrame: true,
        reason: 'active',
        path: 'wasm',
      },
      animation: {
        available: true,
        activeThisFrame: false,
        reason: 'below-gate',
        path: 'js',
      },
      hitTest: {
        available: true,
        activeThisFrame: true,
        reason: 'active',
        path: 'wasm-fused',
      },
      particle: {
        available: true,
        activeThisFrame: true,
        reason: 'active',
        path: 'webgpu',
      },
    };
    Object.defineProperty(scene, 'accelerators', { get: () => stub });

    const info = inspectAccelerators(scene);
    expect(info.activeCount).toBe(3);
    expect(info.availableCount).toBe(4);
    expect(info.summary).toContain('transform:wasm');
    expect(info.summary).toContain('particle:webgpu');
    scene.destroy();
  });

  it('formats rows that distinguish a fault from an absence', () => {
    const scene = makeScene();
    const stub = {
      transform: {
        available: true,
        activeThisFrame: false,
        reason: 'rejected',
        path: 'js',
      },
      animation: {
        available: false,
        activeThisFrame: false,
        reason: 'not-installed',
        path: 'js',
      },
      hitTest: {
        available: true,
        activeThisFrame: true,
        reason: 'active',
        path: 'wasm',
      },
      particle: {
        available: false,
        activeThisFrame: false,
        reason: 'not-applicable',
        path: 'none',
      },
    };
    Object.defineProperty(scene, 'accelerators', { get: () => stub });

    const rows = formatAcceleratorInspection(inspectAccelerators(scene));
    const byLabel = new Map(rows.map((r) => [r.label, r]));
    expect(byLabel.get('transform')!.note).toMatch(/FAULT/);
    expect(byLabel.get('animation')!.note).toMatch(/not installed/);
    // An active row shows the path it ran on, not a reason code.
    expect(byLabel.get('hitTest')!.value).toBe('wasm');
    expect(byLabel.get('active')!.value).toBe('1/2');
    scene.destroy();
  });
});
