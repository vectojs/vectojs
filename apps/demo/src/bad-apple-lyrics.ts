import { Scene, Entity, LayoutEngine, LayoutResultBuffer } from '@vecto-ui/core';
import { setupNavBar } from './shared/navBar';
import { setupFPSMonitor } from './shared/fpsMonitor';

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
  private buffer: LayoutResultBuffer;
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
    this.buffer = new LayoutResultBuffer();

    // 建立一个低分辨率的隐藏离屏碰撞贴图，用于 60FPS 极速判断
    this.offCanvas = document.createElement('canvas');
    this.offCanvas.width = this.COLS;
    this.offCanvas.height = this.ROWS;
    this.offCtx = this.offCanvas.getContext('2d', { willReadFrequently: true })!;
    this.offCtx.imageSmoothingEnabled = false;

    this.y = 50; // Offset below the navigation bar

    // Frame-change fingerprint: sample 4 pixels to detect if video has advanced
    this._lastFrameHash = -1;
  }

  private _lastFrameHash: number;

  isPointInside() {
    return false;
  }

  update(dt: number, time: number) {
    super.update(dt, time);
    if (this.video.readyState < this.video.HAVE_CURRENT_DATA) return;

    // 1. 将视频当前帧硬刷到碰撞贴图
    this.offCtx.drawImage(this.video, 0, 0, this.COLS, this.ROWS);
    const imgData = this.offCtx.getImageData(0, 0, this.COLS, this.ROWS).data;

    // ── Frame-change detection ────────────────────────────────────────────
    // Sample 8 pixels spread across the frame to cheaply detect if the video
    // has advanced. layoutText on the full LYRICS string is O(N) and very
    // expensive; we skip it when the frame hasn't changed.
    const step = Math.floor((this.COLS * this.ROWS) / 8) * 4;
    let hash = 0;
    for (let s = 0; s < 8; s++) {
      hash = (hash * 31 + imgData[s * step]) | 0;
    }
    if (hash === this._lastFrameHash) return; // same frame — skip relayout
    this._lastFrameHash = hash;
    // ─────────────────────────────────────────────────────────────────────

    const screenW = window.innerWidth;
    const screenH = window.innerHeight;

    // 2. 定义排版引擎的 Exclusion Mask (物理排斥蒙版)
    const exclusionMask = (x: number, y: number, w: number, h: number) => {
      const cx = Math.floor(((x + w / 2) / screenW) * this.COLS);
      const cy = Math.floor(((y + h / 2) / screenH) * this.ROWS);

      if (cx < 0 || cx >= this.COLS || cy < 0 || cy >= this.ROWS) return false;

      const idx = (cy * this.COLS + cx) * 4;
      const brightness = (imgData[idx] + imgData[idx + 1] + imgData[idx + 2]) / 3;
      return brightness < 127;
    };

    // 3. 仅在视频帧变化时重排 (帧率受视频 FPS 限制，而非 rAF 60fps)
    this.layoutEngine.layoutTextIntoBuffer(
      this.text,
      {},
      this.fontSize,
      this.buffer,
      exclusionMask,
    );
  }

  render(renderer: any) {
    // 极速渲染管线
    const count = this.buffer.count;
    const chars = this.buffer.chars;
    const xs = this.buffer.xs;
    const ys = this.buffer.ys;

    for (let i = 0; i < count; i++) {
      renderer.save();
      // 这里使用原生 fillText 演示极限性能
      renderer.translate(xs[i], ys[i] + this.fontSize * 0.8);
      renderer.fillText(chars[i], 0, 0, `bold ${this.fontSize}px monospace`, '#ffffff');
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
  setupFPSMonitor('Lyrics Reflow', () => isRunning);
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

bootstrap();
