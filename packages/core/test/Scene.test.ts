// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

// Minimal window mock for CanvasRenderer
(globalThis as any).window = {
  innerWidth: 800,
  innerHeight: 600,
  devicePixelRatio: 1,
  addEventListener: vi.fn(),
};

import { Scene } from '../src/tree/Scene';
import { Entity } from '../src/tree/Entity';

describe('Scene', () => {
  it('add() increases root child count', () => {
    const scene = new Scene(mockCanvas as any);
    const e = new Entity();
    scene.add(e);
    // Access root via the private scene graph
    expect((scene as any).root.children.length).toBe(1);
  });

  it('remove() decreases root child count', () => {
    const scene = new Scene(mockCanvas as any);
    const e = new Entity();
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
});
