import { Entity, Scene } from '@vectojs/core';
import type { IRenderer } from '@vectojs/core';

/**
 * Deterministic ML-teaching animation: gradient descent on a 1D quadratic
 * loss. The trajectory is fully precomputed in the constructor (fixed learning
 * rate, no randomness); stepped time only reveals it step by step.
 *
 * No wall clock, no randomness, no scene.start() — see data-chart.ts.
 */

const WIDTH = 1280;
const HEIGHT = 720;

// Left panel: the loss landscape f(x) = 0.5 * (x - 2)^2.
const LOSS_X0 = 90;
const LOSS_X1 = 590;
const LOSS_Y0 = 150; // top (max loss)
const LOSS_Y1 = 600; // bottom (zero loss)
const X_MIN = -1.4;
const X_MAX = 5.4;
const LOSS_MAX = 0.5 * (X_MIN - 2) * (X_MIN - 2);

// Right panel: loss-vs-step plot.
const PLOT_X0 = 700;
const PLOT_X1 = 1210;
const PLOT_Y0 = 150;
const PLOT_Y1 = 600;

const STEPS = 40;
const LR = 0.32;
const X_START = -1.2;
const STEP_MS = 150; // one descent step every 150 ms of stepped time

class GradientDescent1D extends Entity {
  private readonly trajectory: number[]; // x after each step; [0] = x_start
  private time = 0;

  constructor() {
    super();
    this.width = WIDTH;
    this.height = HEIGHT;
    const xs = [X_START];
    for (let i = 0; i < STEPS; i++) {
      const x = xs[xs.length - 1];
      xs.push(x - LR * (x - 2)); // x' = x - lr * f'(x), f'(x) = x - 2
    }
    this.trajectory = xs;
  }

  public override isPointInside(): boolean {
    return false;
  }

  private loss(x: number): number {
    return 0.5 * (x - 2) * (x - 2);
  }

  /** Continuous descent progress: whole steps plus a fractional in-flight step. */
  private progress(): number {
    return Math.min(this.time / STEP_MS, STEPS);
  }

  /** Interpolated x between trajectory[k] and trajectory[k+1] for progress p. */
  private xAt(p: number): number {
    const k = Math.min(Math.floor(p), STEPS - 1);
    const frac = p - k;
    return this.trajectory[k] + (this.trajectory[k + 1] - this.trajectory[k]) * frac;
  }

  public override update(dt: number, _time: number): void {
    super.update(dt, _time);
    this.time += dt;
  }

  private lossY(loss: number): number {
    return LOSS_Y1 - (loss / LOSS_MAX) * (LOSS_Y1 - LOSS_Y0);
  }

  private lossX(x: number): number {
    return LOSS_X0 + ((x - X_MIN) / (X_MAX - X_MIN)) * (LOSS_X1 - LOSS_X0);
  }

  public override render(renderer: IRenderer): void {
    renderer.beginPath();
    renderer.moveTo(0, 0);
    renderer.lineTo(WIDTH, 0);
    renderer.lineTo(WIDTH, HEIGHT);
    renderer.lineTo(0, HEIGHT);
    renderer.closePath();
    renderer.fill('#0b1220');

    renderer.fillText(
      'gradient descent on f(x) = ½(x − 2)²',
      60,
      70,
      'bold 36px sans-serif',
      '#e2e8f0',
    );
    renderer.fillText(
      `lr = ${LR}   step = ${Math.min(STEPS, Math.floor(this.progress()))} / ${STEPS}`,
      60,
      108,
      '24px monospace',
      '#94a3b8',
    );

    this.landscape(renderer);
    this.lossPlot(renderer);
  }

  private landscape(renderer: IRenderer): void {
    // Axes.
    renderer.beginPath();
    renderer.moveTo(LOSS_X0, LOSS_Y1);
    renderer.lineTo(LOSS_X1, LOSS_Y1);
    renderer.closePath();
    renderer.stroke('#1e293b', 1);

    // Curve.
    renderer.beginPath();
    for (let px = LOSS_X0; px <= LOSS_X1; px += 2) {
      const x = X_MIN + ((px - LOSS_X0) / (LOSS_X1 - LOSS_X0)) * (X_MAX - X_MIN);
      const py = this.lossY(this.loss(x));
      if (px === LOSS_X0) renderer.moveTo(px, py);
      else renderer.lineTo(px, py);
    }
    renderer.stroke('#475569', 2);

    // Walked path: dashed segments along the curve between revealed points.
    const p = this.progress();
    const whole = Math.min(Math.floor(p), STEPS);
    renderer.beginPath();
    for (let i = 0; i <= whole; i++) {
      const px = this.lossX(this.trajectory[i]);
      const py = this.lossY(this.loss(this.trajectory[i]));
      if (i === 0) renderer.moveTo(px, py);
      else renderer.lineTo(px, py);
    }
    // In-flight fractional position.
    const cx = this.xAt(p);
    renderer.lineTo(this.lossX(cx), this.lossY(this.loss(cx)));
    renderer.stroke('rgba(245,158,11,0.75)', 2);

    // Revealed points + current ball.
    for (let i = 0; i <= whole; i++) {
      renderer.fillCircle(
        this.lossX(this.trajectory[i]),
        this.lossY(this.loss(this.trajectory[i])),
        4,
        '#f59e0b',
      );
    }
    renderer.fillCircle(this.lossX(cx), this.lossY(this.loss(cx)), 9, '#ef4444');

    // Minimum marker.
    renderer.beginPath();
    renderer.moveTo(this.lossX(2), LOSS_Y1);
    renderer.lineTo(this.lossX(2), this.lossY(0) - 12);
    renderer.closePath();
    renderer.stroke('rgba(34,197,94,0.5)', 1.5);
    renderer.fillText('min', this.lossX(2) + 8, this.lossY(0) - 14, '20px sans-serif', '#22c55e');

    renderer.fillText('loss landscape', LOSS_X0, LOSS_Y0 - 24, '22px sans-serif', '#94a3b8');
    renderer.fillText(
      `x = ${cx.toFixed(3)}   f(x) = ${this.loss(cx).toFixed(4)}`,
      LOSS_X0,
      LOSS_Y1 + 40,
      '22px monospace',
      '#cbd5e1',
    );
  }

  private lossPlot(renderer: IRenderer): void {
    renderer.beginPath();
    renderer.moveTo(PLOT_X0, PLOT_Y1);
    renderer.lineTo(PLOT_X1, PLOT_Y1);
    renderer.closePath();
    renderer.stroke('#1e293b', 1);

    const p = this.progress();
    const whole = Math.min(Math.floor(p), STEPS);
    const maxLoss = this.loss(X_START);
    const px = (step: number) => PLOT_X0 + (step / STEPS) * (PLOT_X1 - PLOT_X0);
    const py = (loss: number) => PLOT_Y1 - (loss / maxLoss) * (PLOT_Y1 - PLOT_Y0);

    renderer.beginPath();
    for (let i = 0; i <= whole; i++) {
      const x = px(i);
      const y = py(this.loss(this.trajectory[i]));
      if (i === 0) renderer.moveTo(x, y);
      else renderer.lineTo(x, y);
    }
    renderer.stroke('#38bdf8', 2);

    for (let i = 0; i <= whole; i++) {
      renderer.fillCircle(px(i), py(this.loss(this.trajectory[i])), 4, '#38bdf8');
    }

    renderer.fillText('loss per step', PLOT_X0, PLOT_Y0 - 24, '22px sans-serif', '#94a3b8');
    renderer.fillText('0', PLOT_X0 - 20, PLOT_Y1 + 6, '20px sans-serif', '#64748b');
    renderer.fillText(
      this.loss(this.trajectory[whole]).toFixed(4),
      PLOT_X0 - 20,
      py(this.loss(this.trajectory[whole])) + 6,
      '20px sans-serif',
      '#64748b',
    );
  }
}

const canvas = document.getElementById('app') as HTMLCanvasElement;
canvas.width = WIDTH;
canvas.height = HEIGHT;

const scene = new Scene(canvas);
(window as unknown as { vectoScene?: Scene }).vectoScene = scene;
scene.add(new GradientDescent1D());
// No scene.start(): the exporter's stop()+step(dt) sequence is the only clock.
