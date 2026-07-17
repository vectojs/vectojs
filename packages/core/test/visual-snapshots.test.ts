// @vitest-environment jsdom
import { describe, it, expect, vi, afterAll } from 'vitest';

(globalThis as any).window = {
  innerWidth: 400,
  innerHeight: 300,
  devicePixelRatio: 1,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
};

const originalGetContext = HTMLCanvasElement.prototype.getContext;

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

import { Scene, Rect, Circle, Group } from '../src/index';

function makeScene(w = 400, h = 300) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const scene = new Scene(canvas, { contentProjection: false, disableWindowResize: true });
  scene.resize(w, h);
  return { canvas, scene };
}

function snapshot(scene: Scene) {
  expect(scene.toSVG()).toMatchSnapshot();
}

describe('visual snapshots — deterministic toSVG', () => {
  afterAll(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  });

  it('Rect — fill, radius, stroke', () => {
    const { scene } = makeScene();
    scene.add(
      new Rect({ width: 140, height: 80, fill: '#6366f1', radius: 12 }).set({ x: 10, y: 10 }),
    );
    scene.add(
      new Rect({ width: 100, height: 80, stroke: '#f59e0b', strokeWidth: 4, fill: null }).set({
        x: 170,
        y: 10,
      }),
    );
    scene.add(
      new Rect({ width: 260, height: 40, fill: '#10b981', radius: 20 }).set({ x: 10, y: 110 }),
    );
    scene.step(16.67);
    snapshot(scene);
  });

  it('Circle — fill, stroke', () => {
    const { scene } = makeScene();
    scene.add(new Circle({ radius: 60, fill: '#ef4444' }).set({ x: 80, y: 80 }));
    scene.add(
      new Circle({ radius: 50, stroke: '#3b82f6', strokeWidth: 4, fill: null }).set({
        x: 240,
        y: 80,
      }),
    );
    scene.add(
      new Circle({ radius: 30, fill: '#8b5cf6', stroke: '#c084fc', strokeWidth: 2 }).set({
        x: 160,
        y: 180,
      }),
    );
    scene.step(16.67);
    snapshot(scene);
  });

  it('Group — transform chain', () => {
    const { scene } = makeScene();
    const group = new Group();
    group.set({ x: 200, y: 150, scaleX: 1.5, scaleY: 1.5, rotation: Math.PI / 6 });
    group.add(
      new Rect({ width: 80, height: 80, fill: '#06b6d4', radius: 8 }).set({ x: -40, y: -40 }),
    );
    scene.add(group);
    scene.step(16.67);
    snapshot(scene);
  });

  it('Overlay — showOverlay draws on top', () => {
    const { scene } = makeScene();
    scene.add(new Rect({ width: 400, height: 300, fill: '#f1f5f9' }));
    scene.showOverlay(
      new Rect({ width: 200, height: 140, fill: '#ffffff', radius: 12 }).set({ x: 100, y: 80 }),
    );
    scene.step(16.67);
    snapshot(scene);
  });

  it('Animation — spring at midpoint', () => {
    const { scene } = makeScene();
    const box = new Rect({ width: 80, height: 80, fill: '#f43f5e', radius: 8 }).set({
      x: 20,
      y: 20,
    });
    scene.add(box);
    box.setTransition({ x: 'spring' });
    box.x = 280;
    for (let i = 0; i < 30; i++) scene.step(16.67);
    expect(box.x).toBeGreaterThan(20);
    expect(box.x).toBeLessThan(280);
    snapshot(scene);
  });

  it('Opacity — transparent overlap', () => {
    const { scene } = makeScene();
    scene.add(
      new Rect({ width: 120, height: 120, fill: '#6366f1' }).set({ x: 30, y: 30, opacity: 0.5 }),
    );
    scene.add(
      new Rect({ width: 120, height: 120, fill: '#ef4444' }).set({ x: 80, y: 80, opacity: 0.5 }),
    );
    scene.step(16.67);
    snapshot(scene);
  });
});
