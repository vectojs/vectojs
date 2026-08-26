import { Entity, Scene } from '@vectojs/core';
import type { IRenderer } from '@vectojs/core';

/**
 * Deterministic math-teaching animation: a radius rotating around a unit
 * circle traces the sine wave scrolling to its right.
 *
 * Every drawn value is a pure function of accumulated stepped time — no wall
 * clock, no randomness, no scene.start() (see data-chart.ts for the contract).
 */

const WIDTH = 1280;
const HEIGHT = 720;

const CIRCLE_CX = 300;
const CIRCLE_CY = 400;
const RADIUS = 190;

const WAVE_X0 = 560;
const WAVE_X1 = 1240;
const WAVE_MID = CIRCLE_CY;
const WAVE_AMP = 190;

const ANGULAR_SPEED = (2 * Math.PI) / 4000; // one full turn per 4 s of stepped time

class UnitCircleSine extends Entity {
  private time = 0;

  constructor() {
    super();
    this.width = WIDTH;
    this.height = HEIGHT;
  }

  public override isPointInside(): boolean {
    return false;
  }

  public override update(dt: number, _time: number): void {
    super.update(dt, _time);
    this.time += dt;
  }

  public override render(renderer: IRenderer): void {
    this.background(renderer);
    const theta = (this.time * ANGULAR_SPEED) % (2 * Math.PI);

    this.axes(renderer);
    this.circle(renderer);
    this.wave(renderer, theta);
    this.radius(renderer, theta);
    this.labels(renderer, theta);
  }

  private background(renderer: IRenderer): void {
    renderer.beginPath();
    renderer.moveTo(0, 0);
    renderer.lineTo(WIDTH, 0);
    renderer.lineTo(WIDTH, HEIGHT);
    renderer.lineTo(0, HEIGHT);
    renderer.closePath();
    renderer.fill('#0b1220');
  }

  private axes(renderer: IRenderer): void {
    // Circle axes.
    renderer.beginPath();
    renderer.moveTo(CIRCLE_CX - RADIUS - 50, CIRCLE_CY);
    renderer.lineTo(CIRCLE_CX + RADIUS + 50, CIRCLE_CY);
    renderer.closePath();
    renderer.stroke('#1e293b', 1);
    renderer.beginPath();
    renderer.moveTo(CIRCLE_CX, CIRCLE_CY - RADIUS - 50);
    renderer.lineTo(CIRCLE_CX, CIRCLE_CY + RADIUS + 50);
    renderer.closePath();
    renderer.stroke('#1e293b', 1);

    // Wave axis.
    renderer.beginPath();
    renderer.moveTo(WAVE_X0, WAVE_MID);
    renderer.lineTo(WAVE_X1, WAVE_MID);
    renderer.closePath();
    renderer.stroke('#1e293b', 1);
  }

  private circle(renderer: IRenderer): void {
    renderer.beginPath();
    renderer.arc(CIRCLE_CX, CIRCLE_CY, RADIUS, 0, 2 * Math.PI);
    renderer.closePath();
    renderer.stroke('#334155', 2);
  }

  private wave(renderer: IRenderer, theta: number): void {
    // The wave head sits at the current angle; scrolling left as theta grows.
    const pxPerRad = (WAVE_X1 - WAVE_X0) / (2 * Math.PI);
    renderer.beginPath();
    for (let x = WAVE_X0; x <= WAVE_X1; x += 2) {
      const t = theta - (x - WAVE_X0) / pxPerRad;
      const y = WAVE_MID - Math.sin(t) * WAVE_AMP;
      if (x === WAVE_X0) renderer.moveTo(x, y);
      else renderer.lineTo(x, y);
    }
    renderer.stroke('#38bdf8', 3);

    // Head point, horizontally aligned with the circle point.
    const headY = WAVE_MID - Math.sin(theta) * WAVE_AMP;
    renderer.fillCircle(WAVE_X0, headY, 6, '#38bdf8');

    // Guide line from the circle point to the wave head.
    const py = CIRCLE_CY - Math.sin(theta) * RADIUS;
    renderer.beginPath();
    renderer.moveTo(CIRCLE_CX + Math.cos(theta) * RADIUS, py);
    renderer.lineTo(WAVE_X0, headY);
    renderer.closePath();
    renderer.stroke('rgba(56,189,248,0.35)', 1.5);
  }

  private radius(renderer: IRenderer, theta: number): void {
    const px = CIRCLE_CX + Math.cos(theta) * RADIUS;
    const py = CIRCLE_CY - Math.sin(theta) * RADIUS;

    renderer.beginPath();
    renderer.moveTo(CIRCLE_CX, CIRCLE_CY);
    renderer.lineTo(px, py);
    renderer.closePath();
    renderer.stroke('#f59e0b', 3);

    renderer.fillCircle(px, py, 8, '#ef4444');
    renderer.fillCircle(CIRCLE_CX, CIRCLE_CY, 5, '#94a3b8');

    // Vertical projection of the point onto the horizontal axis.
    renderer.beginPath();
    renderer.moveTo(px, py);
    renderer.lineTo(px, CIRCLE_CY);
    renderer.closePath();
    renderer.stroke('rgba(239,68,68,0.4)', 1.5);
  }

  private labels(renderer: IRenderer, theta: number): void {
    renderer.fillText('unit circle → sine wave', 60, 70, 'bold 36px sans-serif', '#e2e8f0');
    renderer.fillText(
      `θ = ${((theta * 180) / Math.PI).toFixed(0).padStart(3, '0')}°   sin θ = ${Math.sin(theta).toFixed(3)}`,
      60,
      108,
      '24px monospace',
      '#94a3b8',
    );
    renderer.fillText('sin θ', WAVE_X0 + 8, WAVE_MID - WAVE_AMP - 16, '22px sans-serif', '#38bdf8');
    renderer.fillText('1', CIRCLE_CX + 8, CIRCLE_CY - RADIUS - 8, '20px sans-serif', '#64748b');
    renderer.fillText('-1', CIRCLE_CX + 8, CIRCLE_CY + RADIUS + 26, '20px sans-serif', '#64748b');
  }
}

const canvas = document.getElementById('app') as HTMLCanvasElement;
canvas.width = WIDTH;
canvas.height = HEIGHT;

const scene = new Scene(canvas);
(window as unknown as { vectoScene?: Scene }).vectoScene = scene;
scene.add(new UnitCircleSine());
// No scene.start(): export scenes stay idle so the exporter's stop()+step(dt)
// sequence is the only clock (see data-chart.ts).
