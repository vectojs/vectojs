import { Scene, Entity } from '@vecto-ui/core';
import { setupNavBar } from './shared/navBar';
import { setupFPSMonitor } from './shared/fpsMonitor';

if ((window as any).__VECTO_HMR_CLEANUP) {
  (window as any).__VECTO_HMR_CLEANUP();
}
let isRunning = true;
(window as any).__VECTO_HMR_CLEANUP = () => {
  isRunning = false;
};

/**
 * A GPU point-cloud particle: drifts and bounces inside the viewport. It opts
 * into the WebGL point layer via `getBatchCircle()`, so all instances render in
 * a single draw call.
 */
class Particle extends Entity {
  private vx: number;
  private vy: number;
  private radius: number;
  private color: string;
  private rect: boolean;
  constructor(radius: number, color: string, rect: boolean) {
    super();
    this.radius = radius;
    this.color = color;
    this.rect = rect;
    this.vx = (Math.random() - 0.5) * 60;
    this.vy = (Math.random() - 0.5) * 60;
  }
  isPointInside(): boolean {
    return false;
  }
  getBatchCircle() {
    return this.rect ? null : { radius: this.radius, color: this.color };
  }
  getBatchRect() {
    return this.rect
      ? { width: this.radius * 2, height: this.radius * 2, color: this.color }
      : null;
  }
  render(): void {}
  update(dt: number): void {
    const s = dt / 1000;
    this.x += this.vx * s;
    this.y += this.vy * s;
    if (this.x < 0 || this.x > window.innerWidth) this.vx = -this.vx;
    if (this.y < 0 || this.y > window.innerHeight) this.vy = -this.vy;
    if (this.rect) this.rotation += s; // rects spin to show rotation support
  }
}

function bootstrap() {
  document.body.innerHTML = '';
  document.body.style.cssText = 'margin:0;overflow:hidden;background:#0b1020';

  const parent = document.createElement('div');
  parent.style.cssText = 'position:relative;width:100vw;height:100vh';
  document.body.appendChild(parent);

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;top:0;left:0';
  parent.appendChild(canvas);

  const params = new URLSearchParams(location.search);
  const N = Number(params.get('n') ?? 100_000);
  // ?shape=rect → spinning GPU rectangles (instanced-triangle batch) instead of points.
  const rect = params.get('shape') === 'rect';

  const scene = new Scene(canvas, { pointBackend: 'webgl' });

  const palette = ['#38bdf8', '#a78bfa', '#f472b6', '#34d399', '#fbbf24'];
  for (let i = 0; i < N; i++) {
    const p = new Particle(rect ? 4 : 1.5, palette[i % palette.length], rect);
    p.setPosition(Math.random() * window.innerWidth, Math.random() * window.innerHeight);
    scene.add(p);
  }

  scene.start();
  setupFPSMonitor(`WebGL ${rect ? 'Rects' : 'Points'} ×${N.toLocaleString()}`, () => isRunning);
  setupNavBar('#webgl-points');

  const hint = document.createElement('div');
  hint.style.cssText =
    'position:absolute;left:50%;bottom:40px;transform:translateX(-50%);color:#94a3b8;font:14px sans-serif;pointer-events:none;z-index:20';
  hint.textContent = rect
    ? `${N.toLocaleString()} GPU rects (instanced-triangle batch) — try ?shape=rect&n=500000.`
    : `${N.toLocaleString()} GPU points in one draw call — ?n=1000000 to push it, ?shape=rect for rectangles.`;
  parent.appendChild(hint);
}

bootstrap();
