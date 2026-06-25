import { Scene, Entity, LayoutEngine } from '@vecto/core';

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

  constructor(text: string, atlas: any) {
    super();
    this.layoutEngine = new LayoutEngine(window.innerWidth - 100, window.innerHeight);

    // We pass an empty atlas {} so it falls back to a standard monospace width
    // This fixes the massive gaps caused by the 8-bit retro font atlas metrics!
    const res = this.layoutEngine.layoutText(text, {}, this.fontSize);

    // 初始化物理字符
    for (const node of res.nodes) {
      this.chars.push(new PhysicsChar(node.char, node.x + 50, node.y + 100, node.height));
    }

    this.interactive = true;

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

    // 交互力场 (Mouse Drag)
    if (this.isDragging) {
      for (const c of this.chars) {
        const dx = this.mouseX - c.x;
        const dy = this.mouseY - c.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 150) {
          // 磁性吸引半径
          const force = (150 - dist) * 0.15;
          c.vx += (dx / dist) * force;
          c.vy += (dy / dist) * force;
        }
      }
    }

    // 物理积分更新
    for (let i = 0; i < this.chars.length; i++) {
      const left = i > 0 ? this.chars[i - 1] : undefined;
      const right = i < this.chars.length - 1 ? this.chars[i + 1] : undefined;

      // 跨行的邻居不应该互相拉扯 (简单的 Y 坐标判断)
      const validLeft =
        left && Math.abs(left.targetY - this.chars[i].targetY) < 10 ? left : undefined;
      const validRight =
        right && Math.abs(right.targetY - this.chars[i].targetY) < 10 ? right : undefined;

      this.chars[i].update(validLeft, validRight);
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
  setupFPSMonitor();
  setupNavBar();
}

function setupNavBar() {
  const nav = document.createElement('div');
  nav.style.position = 'fixed';
  nav.style.top = '0';
  nav.style.left = '0';
  nav.style.width = '100%';
  nav.style.zIndex = '9999';
  nav.style.background = 'rgba(0,0,0,0.8)';
  nav.style.color = 'white';
  nav.style.padding = '10px';
  nav.style.fontFamily = 'monospace';
  nav.style.display = 'flex';
  nav.style.gap = '20px';
  nav.style.alignItems = 'center';
  nav.style.borderBottom = '1px solid #444';

  nav.innerHTML = `
    <b style="color: #38bdf8;">Vectomancy Pro</b>
    <a href="#physics" style="color: #fff; text-decoration: none;" onclick="setTimeout(()=>location.reload(), 10)">📚 Hooke's Law Physics Text</a>
    <a href="#bad-apple-lyrics" style="color: #fff; text-decoration: none;" onclick="setTimeout(()=>location.reload(), 10)">🎵 Lyrics Reflow</a>
    <a href="#bad-apple-classic" style="color: #fff; text-decoration: none;" onclick="setTimeout(()=>location.reload(), 10)">🍎 Classic Matrix</a>
    <a href="#bad-apple-variable" style="color: #fca5a5; text-decoration: none;" onclick="setTimeout(()=>location.reload(), 10)">✨ Variable Font ASCII (Pretext)</a>
  `;
  document.body.appendChild(nav);
}

function setupFPSMonitor() {
  const fpsEl = document.createElement('div');
  fpsEl.style.position = 'absolute';
  fpsEl.style.bottom = '10px';
  fpsEl.style.right = '10px';
  fpsEl.style.color = '#dc322f';
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
      fpsEl.textContent = `FPS: ${frames}${memStr} | Hooke's Law Physics`;
      frames = 0;
      lastTime = now;
    }
    requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
}

bootstrap();
