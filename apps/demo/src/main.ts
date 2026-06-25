import { Scene, TextEntity } from '@vecto/core';

async function bootstrap() {
  // Fix HMR overlapping: Hard reset the body DOM!
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

  // Load the mathematically extracted font curves
  const res = await fetch('/ast/font_glyph_map.json');
  const atlas = await res.json();

  const text = new TextEntity(
    'Vecto Agent Mode 🤖\n1. Shadow DOM Synced\n2. Math Gradients 🌈\n3. Click this box!',
    atlas,
    window.innerWidth - 100,
    48, // Reduced font size to fit gracefully
  );

  text.id = 'demo-text'; // Explicit ID for Agent Automation Tooling
  text.setPosition(50, 100);

  // Setup Gradient Fill
  const gradient = scene.getRenderer().createLinearGradient(0, 0, 800, 400, [
    { stop: 0, color: '#f59e0b' },
    { stop: 0.5, color: '#ec4899' },
    { stop: 1, color: '#8b5cf6' },
  ]);
  text.fillStyle = gradient;
  text.hoveredFillStyle = '#ffffff';

  // Agent / Automation test handler
  text.on('click', () => {
    // Spring morphing animation
    text.animate({ scaleX: 1.1, scaleY: 0.9 }, 150);
    setTimeout(() => text.animate({ scaleX: 0.95, scaleY: 1.05 }, 150), 150);
    setTimeout(() => text.animate({ scaleX: 1.0, scaleY: 1.0 }, 200), 300);
  });

  scene.add(text);
  scene.start();

  setupFPSMonitor();
}

function setupFPSMonitor() {
  const fpsEl = document.createElement('div');
  fpsEl.style.position = 'absolute';
  fpsEl.style.bottom = '10px';
  fpsEl.style.right = '10px';
  fpsEl.style.color = '#38bdf8';
  fpsEl.style.fontFamily = 'monospace';
  fpsEl.style.fontSize = '24px';
  fpsEl.style.pointerEvents = 'none';
  fpsEl.style.zIndex = '99';
  document.body.appendChild(fpsEl);

  let frames = 0;
  let lastTime = performance.now();

  function update() {
    frames++;
    const now = performance.now();
    if (now - lastTime >= 1000) {
      fpsEl.textContent = `FPS: ${frames} | ECS Mode + Shadow A11y`;
      frames = 0;
      lastTime = now;
    }
    requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
}

bootstrap();
