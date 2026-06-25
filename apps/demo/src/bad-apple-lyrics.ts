import { Scene, Entity, LayoutEngine, LayoutNode } from '@vecto/core';
import { setupNavBar } from './shared/navBar';

// HMR 热更新终极杀手：全局拦截并销毁旧的死循环
if ((window as any).__VECTO_HMR_CLEANUP) {
  (window as any).__VECTO_HMR_CLEANUP();
}
let isRunning = true;
(window as any).__VECTO_HMR_CLEANUP = () => {
  isRunning = false;
};

// Bad Apple 歌词 (重复拼接以填满整个屏幕)
const LYRICS = `Ever on and on, I continue circling
With nothing but my hate and the carousel of agony
Till slowly I forget and my heart starts vanishing
And suddenly I see that I can't break free—I'm
Slipping through the cracks of a dark eternity
With nothing but my pain and the paralyzing agony
To tell me who I am! Who I was!
Uncertainty enveloping my mind
Till I can't break free, and
Maybe it's a dream; maybe nothing else is real
But it wouldn't mean a thing if I told you how I feel
So I'm tired of all the pain, all the misery inside
And I wish that I could live feeling nothing but the night
You can tell me what to say; you can tell me where to go
But I doubt that I would care, and my heart would never know
If I make another move there'll be no more turning back
Because everything will change, and it all will fade to black
Will tomorrow ever come? Will I make it through the night?
Will there ever be a place for the broken in the light?
Am I hurting? Am I sad? Should I stay, or should I go?
I've forgotten how to tell. Did I ever even know?
Can I take another step? I've done everything I can
All the people that I see I will never understand
If I find a way to change, if I step into the light
Then I'll never be the same, and it all will fade to white `.repeat(15);

class LyricsMaskEntity extends Entity {
  private layoutEngine: LayoutEngine;
  private nodes: LayoutNode[] = [];
  public text: string = '';
  public fontSize = 16;
  public atlas: any;

  // 物理碰撞层
  public video: HTMLVideoElement;
  public offCanvas: HTMLCanvasElement;
  public offCtx: CanvasRenderingContext2D;
  public COLS: number = 160;
  public ROWS: number = 120;

  constructor(text: string, atlas: any, video: HTMLVideoElement) {
    super();
    this.text = text;
    this.atlas = atlas;
    this.video = video;
    this.layoutEngine = new LayoutEngine(window.innerWidth, window.innerHeight);

    // 建立一个低分辨率的隐藏离屏碰撞贴图，用于 60FPS 极速判断
    this.offCanvas = document.createElement('canvas');
    this.offCanvas.width = this.COLS;
    this.offCanvas.height = this.ROWS;
    this.offCtx = this.offCanvas.getContext('2d', { willReadFrequently: true })!;
    this.offCtx.imageSmoothingEnabled = false;

    this.y = 50; // Offset below the navigation bar
  }

  isPointInside() {
    return false;
  }

  update(dt: number, time: number) {
    super.update(dt, time);
    if (this.video.readyState < this.video.HAVE_CURRENT_DATA) return;

    // 1. 将视频当前帧硬刷到碰撞贴图
    this.offCtx.drawImage(this.video, 0, 0, this.COLS, this.ROWS);
    const imgData = this.offCtx.getImageData(0, 0, this.COLS, this.ROWS).data;

    const screenW = window.innerWidth;
    const screenH = window.innerHeight;

    // 2. 定义排版引擎的 Exclusion Mask (物理排斥蒙版)
    const exclusionMask = (x: number, y: number, w: number, h: number) => {
      // 映射屏幕排版坐标到物理碰撞贴图坐标
      // 由于字体是从基线向下绘制的，我们取字符中心点做碰撞检测
      const cx = Math.floor(((x + w / 2) / screenW) * this.COLS);
      const cy = Math.floor(((y + h / 2) / screenH) * this.ROWS);

      if (cx < 0 || cx >= this.COLS || cy < 0 || cy >= this.ROWS) return false;

      const idx = (cy * this.COLS + cx) * 4;
      const brightness = (imgData[idx] + imgData[idx + 1] + imgData[idx + 2]) / 3;

      // Bad Apple 中人物是黑色的 (明度低)
      // 如果明度低于阈值，说明撞到了物理轮廓，返回 true (排斥该字符)
      return brightness < 127;
    };

    // 3. 启动 V8 Intl.Segmenter 全局折行引擎！(60FPS 实时计算万字折行)
    // Pass empty atlas {} for standard monospace width fallback
    const res = this.layoutEngine.layoutText(this.text, {}, this.fontSize, exclusionMask);
    this.nodes = res.nodes;
  }

  render(renderer: any) {
    // 极速渲染管线
    for (const node of this.nodes) {
      renderer.save();
      // 这里使用原生 fillText 演示极限性能
      renderer.translate(node.x, node.y + this.fontSize * 0.8);
      renderer.fillText(node.char, 0, 0, `bold ${this.fontSize}px monospace`, '#ffffff');
      renderer.restore();
    }
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

  // 加载字体地图
  const res = await fetch('/ast/font_glyph_map.json');
  const atlas = await res.json();

  // 挂载原视频作为画中画对照，以及驱动碰撞引擎
  const video = document.createElement('video');
  video.src = '/bad-apple.mp4';
  video.crossOrigin = 'anonymous';
  video.loop = true;
  video.muted = true;
  video.style.position = 'absolute';
  video.style.top = '20px';
  video.style.left = '20px';
  video.style.width = '240px';
  video.style.border = '2px solid rgba(255,255,255,0.3)';
  video.style.zIndex = '100';
  document.body.appendChild(video);
  video.play();

  // 初始化动态歌词遮罩实体！
  const lyricsEntity = new LyricsMaskEntity(LYRICS, atlas, video);
  scene.add(lyricsEntity);

  scene.start();
  setupFPSMonitor();
  setupNavBar('#bad-apple-lyrics');

  // 提供音频交互
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
  instruction.innerText = '🎬 Click to Start Realtime Text Flow';
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
    if (!isRunning) return; // HMR GC
    frames++;
    const now = performance.now();
    if (now - lastTime >= 1000) {
      const mem = (performance as any).memory;
      const memStr = mem ? ` | Mem: ${(mem.usedJSHeapSize / 1048576).toFixed(1)}MB` : '';
      fpsEl.textContent = `FPS: ${frames}${memStr} | Realtime Lyrics Engine`;
      frames = 0;
      lastTime = now;
    }
    requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
}

bootstrap();
