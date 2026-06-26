import { Scene, Entity, LayoutEngine, type GlyphMeasurer, type IRenderer } from '@vecto-ui/core';
import { Text, Button, Card, Stack, Input, Checkbox, Toggle } from '@vecto-ui/ui';
import { setupFPSMonitor } from './shared/fpsMonitor';

const RENDER_WEIGHT = 600;

function boldMeasurer(): GlyphMeasurer | null {
  if (typeof document === 'undefined') return null;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return null;
  const base = 100;
  const cache = new Map<string, number>();
  return {
    measure(char: string, fontSize: number): number {
      let w = cache.get(char);
      if (w === undefined) {
        ctx.font = `${RENDER_WEIGHT} ${base}px sans-serif`;
        w = ctx.measureText(char).width;
        cache.set(char, w);
      }
      return w * (fontSize / base);
    },
  };
}

if ((window as any).__VECTO_HMR_CLEANUP) {
  (window as any).__VECTO_HMR_CLEANUP();
}
let isRunning = true;
(window as any).__VECTO_HMR_CLEANUP = () => {
  isRunning = false;
};

const pointer = { x: -1e9, y: -1e9, down: false };
export let scrollProgress = 0;

class Glyph extends Entity {
  private homeX: number;
  private homeY: number;
  private vx = 0;
  private vy = 0;
  public size: number;
  private char: string;
  private color: string;
  private litUntil = 0;
  private randX = (Math.random() - 0.5) * 2000;
  private randY = (Math.random() - 0.5) * 2000;

  constructor(char: string, homeX: number, homeY: number, size: number, color: string) {
    super();
    this.char = char;
    this.homeX = homeX;
    this.homeY = homeY;
    this.size = size;
    this.color = color;
    this.x = homeX;
    this.y = homeY;
    this.width = size * 0.62;
    this.height = size;
    this.interactive = false;
  }

  centerX(): number {
    return this.x + this.width / 2;
  }
  centerY(): number {
    return this.y - this.height / 2;
  }

  lit(time: number): void {
    this.litUntil = time + 320;
  }

  isPointInside(gx: number, gy: number): boolean {
    return gx >= this.x && gx <= this.x + this.width && gy <= this.y && gy >= this.y - this.height;
  }

  update(dt: number, time: number): void {
    const frames = Math.min(dt, 48) / 16.67;

    const dx = this.centerX() - pointer.x;
    const dy = this.centerY() - pointer.y;
    const dist = Math.hypot(dx, dy) || 0.0001;
    const radius = pointer.down ? 300 : 200;
    if (dist < radius) {
      const push = (1 - dist / radius) * (pointer.down ? 7 : 4);
      this.vx += (dx / dist) * push * frames;
      this.vy += (dy / dist) * push * frames;
    }

    const scatterStrength = Math.min(1, scrollProgress * 2.5);
    const targetX = this.homeX + this.randX * scatterStrength;
    const targetY = this.homeY + this.randY * scatterStrength;

    this.vx += (targetX - this.x) * 0.06 * frames;
    this.vy += (targetY - this.y) * 0.06 * frames;
    this.vx *= 0.82;
    this.vy *= 0.82;
    this.x += this.vx * frames;
    this.y += this.vy * frames;

    const off = Math.hypot(this.x - this.homeX, this.y - this.homeY);
    const lit = time < this.litUntil;
    this._fill = lit ? '#fbbf24' : off > 4 ? '#f472b6' : this.color;
  }

  private _fill = '#e2e8f0';

  getBounds() {
    return { x: 0, y: -this.height, width: this.width, height: this.height };
  }

  render(r: IRenderer): void {
    r.fillText(this.char, 0, 0, `${RENDER_WEIGHT} ${this.size}px sans-serif`, this._fill);
  }
}

class MagneticText extends Entity {
  private glyphs: Glyph[] = [];

  constructor(lines: { text: string; size: number }[], cx: number, topY: number) {
    super();
    this.interactive = false;
    const engine = new LayoutEngine(1e9, 1e9, boldMeasurer());

    let y = topY;
    for (const line of lines) {
      const prepared = engine.prepare(line.text, {}, line.size);
      const laid = engine.layoutPrepared(prepared);
      const lineWidth = laid.totalWidth;
      const startX = cx - lineWidth / 2;
      for (const node of laid.nodes) {
        if (node.char.trim().length === 0) continue;
        const g = new Glyph(
          node.char,
          startX + node.x,
          y + node.y + line.size,
          line.size,
          '#e2e8f0',
        );
        this.glyphs.push(g);
        this.add(g);
      }
      y += line.size * 1.5;
    }
  }

  hit(wx: number, wy: number, time: number): void {
    for (const g of this.glyphs) {
      if (g.isPointInside(wx, wy)) {
        g.lit(time);
        break;
      }
    }
  }

  get count(): number {
    return this.glyphs.length;
  }

  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

function bootstrap() {
  document.body.innerHTML = '';
  document.body.style.cssText = 'margin:0;overflow-x:hidden;background:#0b1020';

  const proxy = document.createElement('div');
  proxy.style.cssText =
    'position:absolute;top:0;left:0;width:1px;height:300vh;pointer-events:none;z-index:0';
  document.body.appendChild(proxy);

  const parent = document.createElement('div');
  parent.style.cssText = 'position:relative;width:100vw;height:100vh';
  document.body.appendChild(parent);

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:1';
  parent.appendChild(canvas);

  const scene = new Scene(canvas);

  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;

  // The text takes ~230px vertically, and the card takes 320px.
  // We use startY to center the whole group vertically.
  const startY = Math.max(40, cy - 290);

  const text = new MagneticText(
    [
      { text: 'VectoUI', size: 96 },
      { text: 'a Zero-DOM canvas UI runtime', size: 34 },
      { text: 'every glyph is math — move your cursor', size: 22 },
    ],
    cx,
    startY,
  );
  scene.add(text);

  const form = new Stack({ direction: 'vertical', gap: 18 });
  form.add(new Text('Try the A11y UI', { font: '600 20px sans-serif', color: '#e2e8f0' }));
  form.add(new Input({ width: 300, placeholder: 'you@example.com' }));
  form.add(new Input({ width: 300, placeholder: 'Password' }));
  form.add(new Checkbox({ label: 'I accept the terms' }));
  form.add(new Toggle({ label: 'Subscribe to updates', checked: true }));
  form.add(new Button('Create account', { onClick: () => console.log('[gallery] submit') }));

  const card = new Card({ width: 360, height: 320, border: '#334155', padding: 24 });
  card.add(form.setPosition(24, 24));
  scene.add(card.setPosition(cx - 180, startY + 260));

  const finalCardY = startY + 260;
  const cardStartOffset = 400;

  const uiController = new (class extends Entity {
    isPointInside() {
      return false;
    }
    render() {}
  })();
  uiController.update = () => {
    const uiProgress = Math.max(0, Math.min(1, (scrollProgress - 0.4) / 0.6));
    card.y = finalCardY + cardStartOffset * (1 - uiProgress);

    const isInteractive = scrollProgress > 0.95;
    form.interactive = isInteractive;
    card.interactive = isInteractive;
  };
  scene.add(uiController);

  scene.start();

  const move = (e: PointerEvent) => {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerdown', (e) => {
    pointer.down = true;
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    text.hit(e.clientX, e.clientY, performance.now());
  });
  window.addEventListener('pointerup', () => (pointer.down = false));
  window.addEventListener('pointerleave', () => {
    pointer.x = -1e9;
    pointer.y = -1e9;
  });

  setupFPSMonitor(`Magnetic Type ×${text.count} glyphs + A11y UI`, () => isRunning);

  const hint = document.createElement('div');
  hint.style.cssText =
    'position:fixed;left:50%;bottom:20px;transform:translateX(-50%);color:#64748b;font:14px sans-serif;pointer-events:none;z-index:20';
  hint.textContent = 'Move the cursor to repel glyphs · Scroll down to reveal UI';
  parent.appendChild(hint);

  window.addEventListener('scroll', () => {
    const maxScroll = document.body.scrollHeight - window.innerHeight;
    scrollProgress = Math.max(0, Math.min(1, window.scrollY / (maxScroll || 1)));
    if (hint) {
      hint.style.opacity = Math.max(0, 1 - scrollProgress * 3).toString();
    }
  });
  window.scrollTo(0, 0);
  scrollProgress = 0;
}

bootstrap();
