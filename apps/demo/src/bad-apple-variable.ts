import { Scene, Entity } from '@vecto/core';
import { setupNavBar } from './shared/navBar';

if ((window as any).__VECTO_HMR_CLEANUP) {
  (window as any).__VECTO_HMR_CLEANUP();
}
let isRunning = true;
(window as any).__VECTO_HMR_CLEANUP = () => {
  isRunning = false;
};

const CHARSET = ' .,:;!+-=*#@%&abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const WEIGHTS = [300, 500, 800] as const;
const STYLES = ['normal', 'italic'] as const;
const FONT_FAMILY = 'Georgia, Palatino, "Times New Roman", serif';

type FontStyleVariant = (typeof STYLES)[number];
type PaletteEntry = {
  char: string;
  weight: number;
  style: FontStyleVariant;
  font: string;
  brightness: number;
};
type BrightnessEntry = {
  char: string;
  font: string;
  alpha: number;
};

// 1. Precompute brightness LUT
const brightnessCanvas = document.createElement('canvas');
brightnessCanvas.width = 28;
brightnessCanvas.height = 28;
const bCtx = brightnessCanvas.getContext('2d', { willReadFrequently: true })!;

function estimateBrightness(ch: string, font: string): number {
  bCtx.clearRect(0, 0, 28, 28);
  bCtx.font = font;
  bCtx.fillStyle = '#fff';
  bCtx.textBaseline = 'middle';
  bCtx.fillText(ch, 1, 14);
  const data = bCtx.getImageData(0, 0, 28, 28).data;
  let sum = 0;
  for (let index = 3; index < data.length; index += 4) sum += data[index]!;
  return sum / (255 * 28 * 28);
}

const palette: PaletteEntry[] = [];
for (const style of STYLES) {
  for (const weight of WEIGHTS) {
    const font = `${style === 'italic' ? 'italic ' : ''}${weight} 14px ${FONT_FAMILY}`;
    for (const ch of CHARSET) {
      if (ch === ' ') continue;
      const brightness = estimateBrightness(ch, font);
      palette.push({ char: ch, weight, style, font, brightness });
    }
  }
}

const maxBrightness = Math.max(...palette.map((e) => e.brightness));
if (maxBrightness > 0) {
  for (let i = 0; i < palette.length; i++) palette[i].brightness /= maxBrightness;
}
palette.sort((a, b) => a.brightness - b.brightness);

function findBest(targetBrightness: number): PaletteEntry {
  let lo = 0,
    hi = palette.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (palette[mid].brightness < targetBrightness) lo = mid + 1;
    else hi = mid;
  }
  let bestScore = Infinity;
  let best = palette[lo];
  const start = Math.max(0, lo - 15);
  const end = Math.min(palette.length, lo + 15);
  for (let i = start; i < end; i++) {
    const entry = palette[i];
    const score = Math.abs(entry.brightness - targetBrightness);
    if (score < bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  return best;
}

const lookup: BrightnessEntry[] = [];
for (let b = 0; b < 256; b++) {
  const brightness = b / 255;
  if (brightness < 0.05) {
    lookup.push({ char: ' ', font: '', alpha: 0 });
    continue;
  }
  const match = findBest(brightness);
  const alpha = Math.max(0.1, Math.min(1.0, brightness * 1.5));
  lookup.push({ char: match.char, font: match.font, alpha });
}

// 2. Vecto ECS Entity
class VariableGridEntity extends Entity {
  public grid: BrightnessEntry[] = [];
  public cols: number = 0;
  public rows: number = 0;
  public charW: number;
  public charH: number;

  constructor(cols: number, rows: number, fontSize: number) {
    super();
    this.cols = cols;
    this.rows = rows;
    this.charW = fontSize * 0.8;
    this.charH = fontSize;
  }

  isPointInside() {
    return false;
  }

  render(renderer: any) {
    if (this.grid.length === 0) return;

    renderer.save();

    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const entry = this.grid[r * this.cols + c];
        if (!entry || entry.char === ' ') continue;

        renderer.save();
        renderer.translate(c * this.charW + this.x, r * this.charH + this.y + this.charH * 0.8);
        renderer.setGlobalAlpha(entry.alpha);
        renderer.fillText(
          entry.char,
          0,
          0,
          entry.font.replace('14px', `${this.charH}px`),
          '#ffffff',
        );
        renderer.restore();
      }
    }
    renderer.restore();
  }
}

async function bootstrap() {
  document.body.innerHTML = '';
  document.body.style.margin = '0';
  document.body.style.overflow = 'hidden';
  document.body.style.backgroundColor = '#000000';

  const canvasParent = document.createElement('div');
  canvasParent.style.position = 'relative';
  canvasParent.style.width = '100vw';
  canvasParent.style.height = '100vh';
  document.body.appendChild(canvasParent);

  const canvas = document.createElement('canvas');
  canvas.style.position = 'absolute';
  canvas.style.top = '0';
  canvas.style.left = '0';
  canvasParent.appendChild(canvas);

  const scene = new Scene(canvas);

  const COLS = 120;
  const ROWS = 80;

  let fontSize = Math.floor(window.innerWidth / COLS / 0.8);
  if (fontSize * ROWS > window.innerHeight) {
    fontSize = Math.floor(window.innerHeight / ROWS);
  }
  if (fontSize < 4) fontSize = 4;

  const gridEntity = new VariableGridEntity(COLS, ROWS, fontSize);
  const gridW = COLS * gridEntity.charW;
  const gridH = ROWS * gridEntity.charH;
  gridEntity.setPosition((window.innerWidth - gridW) / 2, (window.innerHeight - gridH) / 2 + 30);
  scene.add(gridEntity);

  const video = document.createElement('video');
  video.src = '/bad-apple.mp4';
  video.crossOrigin = 'anonymous';
  video.loop = true;
  video.muted = true;
  video.play();

  const offCanvas = document.createElement('canvas');
  offCanvas.width = COLS;
  offCanvas.height = ROWS;
  const ctx = offCanvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;

  const origUpdate = gridEntity.update.bind(gridEntity);
  gridEntity.update = (dt: number, time: number) => {
    origUpdate(dt, time);
    if (video.readyState >= video.HAVE_CURRENT_DATA) {
      ctx.drawImage(video, 0, 0, COLS, ROWS);
      const imgData = ctx.getImageData(0, 0, COLS, ROWS).data;
      const newGrid = new Array(COLS * ROWS);
      for (let i = 0; i < COLS * ROWS; i++) {
        const idx = i * 4;
        const b = Math.floor((imgData[idx] + imgData[idx + 1] + imgData[idx + 2]) / 3);
        newGrid[i] = lookup[b];
      }
      gridEntity.grid = newGrid;
    }
  };

  scene.start();
  setupFPSMonitor();
  setupNavBar('#bad-apple-variable');

  const instruction = document.createElement('div');
  instruction.style.position = 'absolute';
  instruction.style.top = '50%';
  instruction.style.left = '50%';
  instruction.style.transform = 'translate(-50%, -50%)';
  instruction.style.color = '#fff';
  instruction.style.fontFamily = 'monospace';
  instruction.style.fontSize = '24px';
  instruction.style.cursor = 'pointer';
  instruction.style.padding = '20px';
  instruction.style.border = '2px dashed #fff';
  instruction.style.backgroundColor = 'rgba(0,0,0,0.8)';
  instruction.innerText = '🎬 Click to Start Variable ASCII';
  instruction.style.zIndex = '1000';
  canvasParent.appendChild(instruction);

  instruction.addEventListener('click', () => {
    video.muted = false;
    video.currentTime = 0;
    video.play();
    instruction.style.display = 'none';
  });
}

function setupFPSMonitor() {
  const fpsEl = document.createElement('div');
  fpsEl.style.position = 'absolute';
  fpsEl.style.bottom = '10px';
  fpsEl.style.right = '10px';
  fpsEl.style.color = '#38bdf8';
  fpsEl.style.fontFamily = 'monospace';
  fpsEl.style.fontSize = '20px';
  fpsEl.style.pointerEvents = 'none';
  fpsEl.style.zIndex = '99';
  document.body.appendChild(fpsEl);

  let frames = 0;
  let lastTime = performance.now();

  function update() {
    if (!isRunning) return;
    frames++;
    const now = performance.now();
    if (now - lastTime >= 1000) {
      const mem = (performance as any).memory;
      const memStr = mem ? ` | Mem: ${(mem.usedJSHeapSize / 1048576).toFixed(1)}MB` : '';
      fpsEl.textContent = `FPS: ${frames}${memStr} | Pretext Variable ASCII Demo`;
      frames = 0;
      lastTime = now;
    }
    requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
}

bootstrap();
