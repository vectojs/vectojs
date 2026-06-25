import { Scene, Entity, LayoutEngine } from '@vecto-ui/core';
import { setupNavBar } from './shared/navBar';
import { setupFPSMonitor } from './shared/fpsMonitor';

// HMR 热更新终极杀手
if ((window as any).__VECTO_HMR_CLEANUP) {
  (window as any).__VECTO_HMR_CLEANUP();
}
let isRunning = true;
(window as any).__VECTO_HMR_CLEANUP = () => {
  isRunning = false;
};

const TEXTBOOK = `Chapter V. Extension Of An Elastic Band

HOOKE'S LAW
F = -kx

Section 57. Consider first an elastic band fixed at two pins and lying, in its natural state, along a straight oblique line. If one portion of the band is drawn aside, each neighboring portion is compelled to lengthen a little, so the deformation is transmitted through a finite span instead of remaining at a mathematical point. The band therefore stores strain energy throughout the bent region, and the greater the departure from the natural line, the greater is the elastic pull that urges the material back again. When the hand is removed, the stretched material does not merely creep to its former place, but returns with velocity, because the elastic force acts during the whole of the recovery. The band passes through the straight form by reason of inertia, bends to the opposite side, and only after repeated returns comes finally to rest. The diminution of these successive excursions is due partly to internal friction in the material and partly to the resistance of the surrounding air.

[ INTERACTIVE: Drag any part of this text with your mouse to stretch the elastic band! ]`;

class PhysicsChar {
  char: string;
  targetX: number;
  targetY: number;
  x: number;
  y: number;
  vx: number = 0;
  vy: number = 0;
  fontSize: number;

  constructor(char: string, x: number, y: number, fontSize: number) {
    this.char = char;
    this.targetX = x;
    this.targetY = y;
    this.x = x;
    this.y = y;
    this.fontSize = fontSize;
  }

  update(left?: PhysicsChar, right?: PhysicsChar) {
    // 物理参数
    const kRest = 0.02; // 趋向原始位置的恢复力
    const kNeighbor = 0.15; // 邻居之间的弹簧拉力 (Hooke's Law) - 降低拉力防止爆炸
    const damp = 0.75; // 空气阻力与内摩擦损耗 - 增加阻尼防震荡

    let fx = (this.targetX - this.x) * kRest;
    let fy = (this.targetY - this.y) * kRest;

    // Hooke's Law: 邻居之间的弹性形变力
    if (left) {
      const idealDistX = this.targetX - left.targetX;
      const idealDistY = this.targetY - left.targetY;
      fx += (left.x + idealDistX - this.x) * kNeighbor;
      fy += (left.y + idealDistY - this.y) * kNeighbor;
    }

    if (right) {
      const idealDistX = this.targetX - right.targetX;
      const idealDistY = this.targetY - right.targetY;
      fx += (right.x + idealDistX - this.x) * kNeighbor;
      fy += (right.y + idealDistY - this.y) * kNeighbor;
    }

    this.vx += fx;
    this.vy += fy;
    this.vx *= damp;
    this.vy *= damp;

    // 添加速度上限（防止因为鼠标拖拽力过大导致弹簧体系崩溃）
    const maxV = 20;
    const vMag = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
    if (vMag > maxV) {
      this.vx = (this.vx / vMag) * maxV;
      this.vy = (this.vy / vMag) * maxV;
    }

    this.x += this.vx;
    this.y += this.vy;
  }
}

class PhysicsTextbookEntity extends Entity {
  private layoutEngine: LayoutEngine;
  private chars: PhysicsChar[] = [];
  public fontSize = 22;

  private isDragging = false;
  private mouseX = 0;
  private mouseY = 0;

  // Web Worker integration
  private _worker: Worker | null = null;
  private _sab: SharedArrayBuffer | null = null;

  constructor(text: string, _atlas: any) {
    super();
    this.layoutEngine = new LayoutEngine(window.innerWidth - 100, window.innerHeight);

    // We pass an empty atlas {} so it falls back to a standard monospace width
    // This fixes the massive gaps caused by the 8-bit retro font atlas metrics!
    const res = this.layoutEngine.layoutText(text, {}, this.fontSize);

    // 初始化物理字符
    // Fix: offset chars below the 44px NavBar
    for (const node of res.nodes) {
      this.chars.push(new PhysicsChar(node.char, node.x + 50, node.y + 54, node.height));
    }

    this.interactive = true;

    // Initialise Web Worker for off-thread physics (requires COOP/COEP headers or Vite's
    // ?sharedworker param; falls back to main-thread if SAB is unavailable)
    if (typeof SharedArrayBuffer !== 'undefined') {
      const STRIDE = 6;
      this._sab = new SharedArrayBuffer(
        this.chars.length * STRIDE * Float32Array.BYTES_PER_ELEMENT,
      );
      this._worker = new Worker(new URL('./workers/physics.worker.ts', import.meta.url), {
        type: 'module',
      });
      this._worker.onmessage = (e) => {
        if (e.data.type !== 'done') return;
        // Read updated positions back from SAB
        const arr = new Float32Array(e.data.buffer);
        const STRIDE = 6;
        for (let i = 0; i < this.chars.length; i++) {
          const xi = i * STRIDE;
          this.chars[i].x = arr[xi];
          this.chars[i].y = arr[xi + 1];
          this.chars[i].vx = arr[xi + 2];
          this.chars[i].vy = arr[xi + 3];
        }
      };
    }

    // Use native window events since Shadow DOM might not map pointerdown perfectly
    window.addEventListener('mousedown', (e: any) => {
      this.isDragging = true;
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
    });

    window.addEventListener('mousemove', (e: any) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
    });

    window.addEventListener('mouseup', () => (this.isDragging = false));
  }

  isPointInside() {
    return true; // 占满全屏交互
  }

  update(dt: number, time: number) {
    super.update(dt, time);

    // Mouse drag force field (applied before worker tick)
    if (this.isDragging) {
      for (const c of this.chars) {
        const dx = this.mouseX - c.x;
        const dy = this.mouseY - c.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 150) {
          const force = (150 - dist) * 0.15;
          c.vx += (dx / dist) * force;
          c.vy += (dy / dist) * force;
        }
      }
    }

    // Physics integration — run in Web Worker if available, else fall back to main thread
    if (this._worker && this._sab) {
      // Sync char state into SharedArrayBuffer
      const arr = new Float32Array(this._sab);
      const STRIDE = 6;
      for (let i = 0; i < this.chars.length; i++) {
        const xi = i * STRIDE;
        const c = this.chars[i];
        arr[xi] = c.x;
        arr[xi + 1] = c.y;
        arr[xi + 2] = c.vx;
        arr[xi + 3] = c.vy;
        arr[xi + 4] = c.targetX;
        arr[xi + 5] = c.targetY;
      }
      this._worker.postMessage({
        type: 'update',
        buffer: this._sab,
        count: this.chars.length,
        isDragging: this.isDragging,
        mouseX: this.mouseX,
        mouseY: this.mouseY,
      });
      // Worker result is applied asynchronously in the message handler
    } else {
      // Main-thread fallback
      for (let i = 0; i < this.chars.length; i++) {
        const left = i > 0 ? this.chars[i - 1] : undefined;
        const right = i < this.chars.length - 1 ? this.chars[i + 1] : undefined;
        const validLeft =
          left && Math.abs(left.targetY - this.chars[i].targetY) < 10 ? left : undefined;
        const validRight =
          right && Math.abs(right.targetY - this.chars[i].targetY) < 10 ? right : undefined;
        this.chars[i].update(validLeft, validRight);
      }
    }
  }

  render(renderer: any) {
    renderer.save();

    // 绘制弹性连接线 (展示物理形变)
    renderer.beginPath();
    for (let i = 0; i < this.chars.length; i++) {
      const c = this.chars[i];
      if (i === 0 || Math.abs(this.chars[i - 1].targetY - c.targetY) >= 10) {
        renderer.moveTo(c.x, c.y + c.fontSize * 0.5);
      } else {
        renderer.lineTo(c.x, c.y + c.fontSize * 0.5);
      }
    }
    renderer.stroke('rgba(203, 75, 22, 0.4)', 2);

    // 绘制文字
    for (const c of this.chars) {
      renderer.save();
      renderer.translate(c.x, c.y + c.fontSize * 0.8);

      // Hooke's Law 标题加粗加红
      if (c.targetY < 150) {
        renderer.fillText(c.char, 0, 0, `bold ${c.fontSize}px monospace`, '#cb4b16');
      } else {
        renderer.fillText(c.char, 0, 0, `${c.fontSize}px monospace`, '#657b83');
      }
      renderer.restore();
    }

    renderer.restore();
  }
}

async function bootstrap() {
  document.body.innerHTML = '';
  document.body.style.margin = '0';
  document.body.style.overflow = 'hidden';
  document.body.style.backgroundColor = '#fdf6e3';

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

  const res = await fetch('/ast/font_glyph_map.json');
  const atlas = await res.json();

  const physicsEntity = new PhysicsTextbookEntity(TEXTBOOK, atlas);
  scene.add(physicsEntity);

  scene.start();
  setupFPSMonitor("Hooke's Law Physics", () => isRunning);
  setupNavBar('#physics');
}

bootstrap();
