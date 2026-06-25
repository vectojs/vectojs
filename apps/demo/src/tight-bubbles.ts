import { Scene, Entity, LayoutEngine, GlyphAtlas } from '@vecto/core';

// HMR cleanup guard
if ((window as any).__VECTO_HMR_CLEANUP) {
  (window as any).__VECTO_HMR_CLEANUP();
}
let isRunning = true;
(window as any).__VECTO_HMR_CLEANUP = () => {
  isRunning = false;
};

// ─── Shared canvas context for text measurement ───────────────────────────────
const measureCtx = document.createElement('canvas').getContext('2d')!;
const LINE_HEIGHT = 24;
const FONT = '16px "Helvetica Neue", Helvetica, sans-serif';
const MAX_BUBBLE_WIDTH = 340;
const PADDING = 16;

interface LayoutLine {
  text: string;
  width: number;
}

/**
 * Measure and break `text` into lines that fit within `maxWidth` using
 * Canvas measureText — no DOM layout, no Reflow.
 * Returns lines with their exact pixel width so the bubble can shrink to fit.
 */
function breakLines(text: string, maxWidth: number): LayoutLine[] {
  measureCtx.font = FONT;
  const words = text.split(' ');
  const lines: LayoutLine[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    const w = measureCtx.measureText(candidate).width;
    if (w > maxWidth && current) {
      lines.push({ text: current, width: measureCtx.measureText(current).width });
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) {
    lines.push({ text: current, width: measureCtx.measureText(current).width });
  }
  return lines;
}

// ─── Colors & messages ────────────────────────────────────────────────────────
const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4'];
const MESSAGES = [
  "Hey! How's it going?",
  "I'm building a zero-DOM Canvas ECS engine. Renders 100,000 entities at 60 FPS!",
  'That sounds awesome! Does it support text wrapping?',
  'Yes! Tight multiline bubbles — no wasted whitespace on the right. The bubble shrinks to the longest line.',
  "That's exactly Pretext's 'Bubbles' demo! How do you measure line width without the DOM?",
  'Canvas measureText() — pure math, zero Reflow. O(N) per frame, GC-free.',
  'Can you drag them around?',
  'Of course. Grab one and fling it! Screen-edge bounce physics included. 🚀',
];

// ─── ChatBubbleEntity ─────────────────────────────────────────────────────────
class ChatBubbleEntity extends Entity {
  private lines: LayoutLine[];
  private tightWidth: number;
  private bgColor: string;

  public vx: number = 0;
  public vy: number = 0;

  constructor(text: string, color: string) {
    super();
    this.bgColor = color;
    this.interactive = true;

    // Break text into lines and find the tightest bounding width
    this.lines = breakLines(text, MAX_BUBBLE_WIDTH);
    this.tightWidth = Math.max(...this.lines.map((l) => l.width));

    // Physical bounding box used for hit-testing and bounce
    this.width = this.tightWidth + PADDING * 2;
    this.height = this.lines.length * LINE_HEIGHT + PADDING * 2;
  }

  isPointInside(gx: number, gy: number): boolean {
    return gx >= this.x && gx <= this.x + this.width && gy >= this.y && gy <= this.y + this.height;
  }

  update(_dt: number, _time: number): void {
    if (!isRunning) return;
    this.x += this.vx;
    this.y += this.vy;

    // Bounce off screen edges (account for navBar height ~44px)
    const minY = 44;
    if (this.x < 0) {
      this.x = 0;
      this.vx *= -0.9;
    }
    if (this.y < minY) {
      this.y = minY;
      this.vy *= -0.9;
    }
    if (this.x + this.width > window.innerWidth) {
      this.x = window.innerWidth - this.width;
      this.vx *= -0.9;
    }
    if (this.y + this.height > window.innerHeight) {
      this.y = window.innerHeight - this.height;
      this.vy *= -0.9;
    }
  }

  render(renderer: any): void {
    const r = 14;
    const w = this.width;
    const h = this.height;

    // Rounded rect bubble background
    renderer.beginPath();
    renderer.moveTo(r, 0);
    renderer.lineTo(w - r, 0);
    renderer.bezierCurveTo(w, 0, w, r, w, r);
    renderer.lineTo(w, h - r);
    renderer.bezierCurveTo(w, h, w - r, h, w - r, h);
    renderer.lineTo(r, h);
    renderer.bezierCurveTo(0, h, 0, h - r, 0, h - r);
    renderer.lineTo(0, r);
    renderer.bezierCurveTo(0, 0, r, 0, r, 0);
    renderer.closePath();
    renderer.fill(this.bgColor);

    // Text lines — only draw up to tightWidth, no extra right-side gap
    let cy = PADDING + LINE_HEIGHT * 0.75; // approx text ascent baseline
    for (const line of this.lines) {
      renderer.fillText(line.text, PADDING, cy, FONT, '#ffffff');
      cy += LINE_HEIGHT;
    }
  }
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────
async function bootstrap() {
  document.body.innerHTML = '';
  document.body.style.margin = '0';
  document.body.style.overflow = 'hidden';
  document.body.style.backgroundColor = '#0f172a';

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

  // Spawn bubbles in a scattered layout
  const bubbles: ChatBubbleEntity[] = [];
  const cols = 2;
  const colW = window.innerWidth / cols;
  for (let i = 0; i < MESSAGES.length; i++) {
    const bubble = new ChatBubbleEntity(MESSAGES[i], COLORS[i % COLORS.length]);
    const col = i % cols;
    bubble.setPosition(
      col * colW + 40 + Math.random() * (colW - bubble.width - 80),
      60 + Math.floor(i / cols) * 120 + Math.random() * 20,
    );
    bubble.vx = (Math.random() - 0.5) * 1.5;
    bubble.vy = (Math.random() - 0.5) * 1.5;
    scene.add(bubble);
    bubbles.push(bubble);
  }

  // ── Drag interaction ──
  let dragged: ChatBubbleEntity | null = null;
  let offX = 0;
  let offY = 0;

  window.addEventListener('pointerdown', (e) => {
    for (let i = bubbles.length - 1; i >= 0; i--) {
      if (bubbles[i].isPointInside(e.clientX, e.clientY)) {
        dragged = bubbles[i];
        offX = e.clientX - dragged.x;
        offY = e.clientY - dragged.y;
        // Pause physics while dragging
        dragged.vx = 0;
        dragged.vy = 0;
        break;
      }
    }
  });

  window.addEventListener('pointermove', (e) => {
    if (dragged) {
      dragged.x = e.clientX - offX;
      dragged.y = e.clientY - offY;
    }
  });

  window.addEventListener('pointerup', (e) => {
    if (dragged) {
      // Give a little fling velocity from pointer movement (simple approximation)
      dragged.vx = (Math.random() - 0.5) * 3;
      dragged.vy = (Math.random() - 0.5) * 3;
      dragged = null;
    }
  });

  scene.start();
  setupNavBar();
}

function setupNavBar() {
  const nav = document.createElement('div');
  nav.style.cssText = `
    position:fixed;top:0;left:0;width:100%;z-index:9999;
    background:rgba(0,0,0,0.85);color:white;padding:10px 16px;
    font-family:monospace;display:flex;gap:20px;align-items:center;
    border-bottom:1px solid #334155;backdrop-filter:blur(8px);
  `;
  nav.innerHTML = `
    <b style="color:#38bdf8;">VectoUI</b>
    <a href="#tight-bubbles" style="color:#fca5a5;text-decoration:none;" onclick="setTimeout(()=>location.reload(),10)">💬 Tight Bubbles</a>
    <a href="#physics" style="color:#94a3b8;text-decoration:none;" onclick="setTimeout(()=>location.reload(),10)">📚 Physics Text</a>
    <a href="#bad-apple-lyrics" style="color:#94a3b8;text-decoration:none;" onclick="setTimeout(()=>location.reload(),10)">🎵 Lyrics Reflow</a>
    <a href="#bad-apple-classic" style="color:#94a3b8;text-decoration:none;" onclick="setTimeout(()=>location.reload(),10)">🍎 Classic Matrix</a>
    <a href="#bad-apple-variable" style="color:#94a3b8;text-decoration:none;" onclick="setTimeout(()=>location.reload(),10)">✨ Variable Font ASCII</a>
  `;
  document.body.appendChild(nav);
}

bootstrap();
