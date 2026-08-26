import { Entity, Scene } from '@vectojs/core';
import type { IRenderer } from '@vectojs/core';

/**
 * Deterministic "post-close market recap" scene.
 *
 * Every pixel is a pure function of a fixed seed and accumulated stepped
 * time: seeded PRNG at construction, no wall-clock reads, no network, no
 * Math.random(). Exporting the same file twice must produce identical frames.
 */

const WIDTH = 1280;
const HEIGHT = 720;

const CHART_LEFT = 90;
const CHART_RIGHT = 1230;
const CHART_TOP = 130;
const CHART_BOTTOM = 600;
const CANDLE_COUNT = 72;

/** Reveal candles over the first 3 s of stepped time (ms). */
const REVEAL_MS = 3000;
/** Scan highlight steps one candle every 250 ms of stepped time. */
const SCAN_PERIOD_MS = 250;

interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildCandles(seed: number): Candle[] {
  const rand = mulberry32(seed);
  const candles: Candle[] = [];
  let close = 100;
  for (let i = 0; i < CANDLE_COUNT; i++) {
    const open = close;
    const drift = 0.0012; // gentle uptrend so the recap reads as a rally
    close = open * (1 + drift + (rand() - 0.5) * 0.02);
    const high = Math.max(open, close) * (1 + rand() * 0.008);
    const low = Math.min(open, close) * (1 - rand() * 0.008);
    candles.push({ open, high, low, close });
  }
  return candles;
}

class MarketRecap extends Entity {
  private readonly candles: Candle[];
  private readonly minLow: number;
  private readonly maxHigh: number;
  private time = 0;

  constructor(seed: number) {
    super();
    this.width = WIDTH;
    this.height = HEIGHT;
    this.candles = buildCandles(seed);
    this.minLow = Math.min(...this.candles.map((c) => c.low));
    this.maxHigh = Math.max(...this.candles.map((c) => c.high));
  }

  /** Candle i's reveal progress in [0, 1] once its slot starts. */
  private revealProgress(i: number): number {
    const per = REVEAL_MS / CANDLE_COUNT;
    const local = (this.time - i * per) / per;
    return Math.min(Math.max(local, 0), 1);
  }

  private revealedCount(): number {
    return Math.min(Math.floor((this.time / REVEAL_MS) * CANDLE_COUNT) + 1, CANDLE_COUNT);
  }

  public override update(dt: number, _time: number): void {
    super.update(dt, _time);
    this.time += dt;
  }

  public override isPointInside(globalX: number, globalY: number): boolean {
    const local = this.worldToLocal(globalX, globalY);
    if (!local) return false;
    return local.x >= 0 && local.x <= this.width && local.y >= 0 && local.y <= this.height;
  }

  private priceToY(price: number): number {
    const pad = (this.maxHigh - this.minLow) * 0.08;
    const t = (price - (this.minLow - pad)) / (this.maxHigh + pad - (this.minLow - pad));
    return CHART_BOTTOM - t * (CHART_BOTTOM - CHART_TOP);
  }

  private candleX(i: number): { center: number; half: number } {
    const span = (CHART_RIGHT - CHART_LEFT) / CANDLE_COUNT;
    return { center: CHART_LEFT + span * (i + 0.5), half: span * 0.32 };
  }

  public override render(renderer: IRenderer): void {
    renderer.beginPath();
    renderer.moveTo(0, 0);
    renderer.lineTo(WIDTH, 0);
    renderer.lineTo(WIDTH, HEIGHT);
    renderer.lineTo(0, HEIGHT);
    renderer.closePath();
    renderer.fill('#0b1220');

    // Horizontal gridlines with price labels.
    for (let g = 0; g <= 4; g++) {
      const price = this.minLow + ((this.maxHigh - this.minLow) * g) / 4;
      const gy = this.priceToY(price);
      renderer.beginPath();
      renderer.moveTo(CHART_LEFT, gy);
      renderer.lineTo(CHART_RIGHT, gy);
      renderer.closePath();
      renderer.stroke('#1e293b', 1);
      renderer.fillText(price.toFixed(2), 16, gy - 8, '20px sans-serif', '#64748b');
    }

    // Scan highlight band behind the currently scanned candle.
    if (this.time >= REVEAL_MS) {
      const scanned = Math.floor(this.time / SCAN_PERIOD_MS) % CANDLE_COUNT;
      const { center, half } = this.candleX(scanned);
      renderer.beginPath();
      renderer.moveTo(center - half * 1.6, CHART_TOP - 30);
      renderer.lineTo(center + half * 1.6, CHART_TOP - 30);
      renderer.lineTo(center + half * 1.6, CHART_BOTTOM + 10);
      renderer.lineTo(center - half * 1.6, CHART_BOTTOM + 10);
      renderer.closePath();
      renderer.fill('rgba(56,189,248,0.08)');
    }

    // Candles: wick stroke + body rect, growing in with their reveal slot.
    for (let i = 0; i < this.revealedCount(); i++) {
      const p = this.revealProgress(i);
      const candle = this.candles[i];
      const up = candle.close >= candle.open;
      const color = up ? '#22c55e' : '#ef4444';
      const { center, half } = this.candleX(i);

      const bodyTop = this.priceToY(candle.open + (candle.close - candle.open) * p);
      const bodyBottom = this.priceToY(candle.open);
      const highY = this.priceToY(candle.high);
      const lowY = this.priceToY(candle.low);

      renderer.beginPath();
      renderer.moveTo(center, highY);
      renderer.lineTo(center, lowY);
      renderer.closePath();
      renderer.stroke(color, 2);

      const top = Math.min(bodyTop, bodyBottom);
      const h = Math.max(Math.abs(bodyBottom - bodyTop), 1.5 * p);
      renderer.beginPath();
      renderer.roundRect(center - half, top, half * 2, h, 2);
      renderer.closePath();
      renderer.fill(color);
    }

    // Close-price polyline across the revealed range.
    const count = this.revealedCount();
    renderer.beginPath();
    for (let i = 0; i < count; i++) {
      const { center } = this.candleX(i);
      const cy = this.priceToY(this.candles[i].close);
      if (i === 0) renderer.moveTo(center, cy);
      else renderer.lineTo(center, cy);
    }
    renderer.stroke('#38bdf8', 2);

    // Header.
    renderer.fillText(
      'VECTOJS · deterministic market recap',
      CHART_LEFT,
      64,
      'bold 40px sans-serif',
      '#e2e8f0',
    );
    renderer.fillText(
      'seeded OHLC walk · scene.step(dt) · zero wall-clock',
      CHART_LEFT,
      96,
      '22px sans-serif',
      '#94a3b8',
    );

    // Live readout of the scanned candle once the reveal completes.
    if (this.time >= REVEAL_MS) {
      const scanned = Math.floor(this.time / SCAN_PERIOD_MS) % CANDLE_COUNT;
      const c = this.candles[scanned];
      const last = this.candles[CANDLE_COUNT - 1].close;
      renderer.fillText(
        `last ${last.toFixed(2)}`,
        CHART_RIGHT - 190,
        72,
        'bold 44px sans-serif',
        '#38bdf8',
      );
      renderer.fillText(
        `#${scanned} O ${c.open.toFixed(2)}  H ${c.high.toFixed(2)}  L ${c.low.toFixed(2)}  C ${c.close.toFixed(2)}`,
        CHART_RIGHT - 560,
        668,
        '24px sans-serif',
        '#cbd5e1',
      );
    }
  }
}

const canvas = document.getElementById('app') as HTMLCanvasElement;
canvas.width = WIDTH;
canvas.height = HEIGHT;

const scene = new Scene(canvas);
(window as unknown as { vectoScene?: Scene }).vectoScene = scene;
scene.add(new MarketRecap(20260826));
// Deliberately NOT calling scene.start(): a running rAF loop advances entity
// state with real wall-clock dt between page load and the exporter's takeover,
// which breaks frame-exact reproducibility across runs. Export scenes must
// stay idle so the exporter's stop()+step(dt) sequence is the sole clock.
