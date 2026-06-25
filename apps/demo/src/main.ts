import { Scene, TextEntity } from '@vecto/core';

async function bootstrap() {
  const canvasParent = document.createElement('div');
  canvasParent.style.position = 'relative';
  canvasParent.style.width = '100vw';
  canvasParent.style.height = '100vh';
  document.body.appendChild(canvasParent);

  const canvas = document.createElement('canvas');
  canvas.style.position = 'absolute';
  canvas.style.top = '0';
  canvas.style.left = '0';
  // Allow clicks to pass through to underlying DOM text for selection,
  // BUT we lose JS events if we set pointer-events: none.
  // For this demo, we keep canvas events to show animations!

  document.body.style.margin = '0';
  document.body.style.overflow = 'hidden';
  document.body.style.backgroundColor = '#0f172a';

  canvasParent.appendChild(canvas);
  const scene = new Scene(canvas);

  const res = await fetch('/ast/font_glyph_map.json');
  const atlas = await res.json();

  const text = new TextEntity(
    'Vecto Framework 🚀\n1. Math Gradients 🌈\n2. Spring Animations ✨\n3. Copy this text!',
    atlas,
    window.innerWidth - 100,
    72,
  );

  text.setPosition(50, window.innerHeight / 2 - 150);

  // Setup Gradient Fill
  const gradient = scene.getRenderer().createLinearGradient(0, -100, 800, 100, [
    { stop: 0, color: '#f59e0b' },
    { stop: 0.5, color: '#ec4899' },
    { stop: 1, color: '#8b5cf6' },
  ]);
  text.fillStyle = gradient;
  text.hoveredFillStyle = '#ffffff';

  // Setup Hidden DOM for Text Selection / Screen Readers
  text.setupHiddenDOM(canvasParent);

  // Animation on click!
  text.on('click', () => {
    // Spring morphing animation simulation
    text.animate({ scaleX: 1.2, scaleY: 0.8 }, 150);
    setTimeout(() => text.animate({ scaleX: 0.9, scaleY: 1.1 }, 150), 150);
    setTimeout(() => text.animate({ scaleX: 1.0, scaleY: 1.0 }, 200), 300);
  });

  scene.add(text);
  scene.start();

  setupFPSMonitor();
}

function setupFPSMonitor() {
  const fpsEl = document.createElement('div');
  fpsEl.style.position = 'absolute';
  fpsEl.style.top = '10px';
  fpsEl.style.left = '10px';
  fpsEl.style.color = '#38bdf8';
  fpsEl.style.fontFamily = 'monospace';
  fpsEl.style.fontSize = '24px';
  fpsEl.style.pointerEvents = 'none';
  document.body.appendChild(fpsEl);

  let frames = 0;
  let lastTime = performance.now();

  function update() {
    frames++;
    const now = performance.now();
    if (now - lastTime >= 1000) {
      fpsEl.textContent = `FPS: ${frames} | ECS Mode + Gradients + Animations`;
      frames = 0;
      lastTime = now;
    }
    requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
}

bootstrap();
