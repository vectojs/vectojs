import { Scene, GridTextEntity } from '@vecto/core';

// HMR 热更新终极杀手：全局拦截并销毁旧的死循环
if ((window as any).__VECTO_HMR_CLEANUP) {
  (window as any).__VECTO_HMR_CLEANUP();
}
let isRunning = true;
(window as any).__VECTO_HMR_CLEANUP = () => {
  isRunning = false;
};

// 字符密度表：从最亮到最暗 (越亮的像素用越密集的字符表示)
const DENSITY = '@%#*+=-:. ';

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

  const res = await fetch('/ast/font_glyph_map.json');
  const atlas = await res.json();

  // Bad Apple 专用矩阵 (120x80)
  const COLS = 120;
  const ROWS = 80;

  // 动态响应式探测：确保网格完美适配不同屏幕，不需要手动缩放
  let fontSize = Math.floor(window.innerWidth / COLS);
  if (fontSize * ROWS * 1.1 > window.innerHeight) {
    fontSize = Math.floor(window.innerHeight / (ROWS * 1.1));
  }
  if (fontSize < 4) fontSize = 4; // 最小保底

  const grid = new GridTextEntity(atlas, fontSize);
  grid.fillStyle = '#ffffff';

  // 精确居中
  const gridWidth = COLS * grid.charWidth;
  const gridHeight = ROWS * grid.charHeight;
  grid.setPosition((window.innerWidth - gridWidth) / 2, (window.innerHeight - gridHeight) / 2);
  scene.add(grid);

  // 挂载隐藏的原生视频标签
  const video = document.createElement('video');
  video.src = '/bad-apple.mp4';
  video.crossOrigin = 'anonymous';
  video.loop = true;
  video.muted = true;
  video.play();

  // 离屏 Canvas (Offscreen) 像素采样器
  const offCanvas = document.createElement('canvas');
  offCanvas.width = COLS;
  offCanvas.height = ROWS;
  const ctx = offCanvas.getContext('2d', { willReadFrequently: true })!;

  // 修复重叠幻影：关闭硬件双线性插值，保持极致锐利的像素边缘
  ctx.imageSmoothingEnabled = false;

  // 暴力劫持 ECS 的逐帧 Update 钩子
  const originalUpdate = grid.update.bind(grid);
  grid.update = (dt: number, time: number) => {
    originalUpdate(dt, time);

    // 如果视频准备好了
    if (video.readyState >= video.HAVE_CURRENT_DATA) {
      // 1. 把视频当前帧硬绘制到极其微小的离屏 Canvas 上
      ctx.drawImage(video, 0, 0, COLS, ROWS);
      // 2. 瞬间提取所有的像素数据
      const imageData = ctx.getImageData(0, 0, COLS, ROWS).data;

      const asciiGrid = [];
      for (let r = 0; r < ROWS; r++) {
        let rowStr = '';
        for (let c = 0; c < COLS; c++) {
          const idx = (r * COLS + c) * 4;
          // RGB 取平均值计算明度
          const brightness = (imageData[idx] + imageData[idx + 1] + imageData[idx + 2]) / 3;

          // 修复重叠幻影：二值化处理，强制消除 mp4 的灰阶压缩噪点
          const contrast = brightness > 127 ? 255 : 0;

          // 明度 (0-255) 映射到 DENSITY 字符串表
          const charIdx = Math.floor((contrast / 255) * (DENSITY.length - 1));
          rowStr += DENSITY[charIdx];
        }
        asciiGrid.push(rowStr);
      }
      // 3. 将 9600 个字符塞回底层 ECS 实体！
      grid.updateGrid(asciiGrid);
    }
  };

  scene.start();
  setupFPSMonitor();

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
  instruction.innerText = '🎬 Click to Start Bad Apple';
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
    if (!isRunning) return; // HMR GC: 立即退出旧实例循环
    frames++;
    const now = performance.now();
    if (now - lastTime >= 1000) {
      // 获取 V8 引擎真实堆内存大小 (仅 Chrome/Edge 支持)
      const mem = (performance as any).memory;
      const memStr = mem ? ` | Mem: ${(mem.usedJSHeapSize / 1048576).toFixed(1)}MB` : '';

      fpsEl.textContent = `FPS: ${frames}${memStr} | Bad Apple 9,600 Entities`;
      frames = 0;
      lastTime = now;
    }
    requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
}

bootstrap();
