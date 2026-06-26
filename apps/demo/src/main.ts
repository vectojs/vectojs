import { Scene } from '@vecto-ui/core';
import { Card, Stack, Text, Toggle, Button, Input } from '@vecto-ui/ui';
import { NexusGraph } from './nexus/NexusGraph';

function bootstrap() {
  document.body.innerHTML = '';
  document.body.style.cssText =
    'margin:0;overflow:hidden;background:#0a0a0f;font-family:"Outfit",sans-serif;color:#fff';

  // We keep the old root for A11y structure
  const parent = document.createElement('div');
  parent.style.cssText = 'position:relative;width:100vw;height:100vh';
  document.body.appendChild(parent);

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;top:0;left:0;width:100vw;height:100vh;z-index:1';
  parent.appendChild(canvas);

  const scene = new Scene(canvas, { pointBackend: 'webgl' });
  const nexus = new NexusGraph(8000); // 8,000 nodes
  scene.add(nexus);

  // Left Panel - Glassmorphism UI
  const leftCard = new Card({
    width: 320,
    height: 420,
    bg: 'rgba(20, 20, 30, 0.65)',
    border: 'rgba(255, 255, 255, 0.1)',
    padding: 24,
    radius: 16,
  });
  const leftStack = new Stack({ direction: 'vertical', gap: 20 });
  leftStack.add(
    new Text('Glassmorphism', { font: '600 24px "Outfit", sans-serif', color: '#fff' }),
  );
  leftStack.add(
    new Input({
      width: 272,
      placeholder: 'Search node...',
      font: '400 15px "Outfit", sans-serif',
      bg: 'rgba(0,0,0,0.4)',
      border: 'rgba(255,255,255,0.1)',
      color: '#fff',
      radius: 8,
    }),
  );

  const physicsToggle = new Toggle({
    label: 'Physics Engine',
    checked: true,
    font: '400 14px "Outfit", sans-serif',
    color: '#fff',
    accent: '#00f0ff',
  });
  physicsToggle.on('change', (e: any) => (nexus.physicsEnabled = e.checked));
  leftStack.add(physicsToggle);

  const spawnBtn = new Button('Spawn 5000 Nodes', {
    bg: 'rgba(0, 240, 255, 0.2)',
    hoverBg: 'rgba(0, 240, 255, 0.4)',
    color: '#00f0ff',
    radius: 8,
    font: '600 14px "Outfit", sans-serif',
  });
  spawnBtn.on('click', () => {
    nexus.addNodes(5000);
  });
  leftStack.add(spawnBtn);

  leftCard.add(leftStack.setPosition(24, 24));
  scene.add(leftCard.setPosition(40, window.innerHeight / 2 - 210));

  // Right Panel - Monitor
  const rightCard = new Card({
    width: 280,
    height: 200,
    bg: 'rgba(20, 20, 30, 0.65)',
    border: 'rgba(255, 255, 255, 0.1)',
    padding: 24,
    radius: 16,
  });
  const rightStack = new Stack({ direction: 'vertical', gap: 16 });

  const fpsText = new Text('FPS: --', { font: '400 16px "Outfit", monospace', color: '#00f0ff' });
  const countText = new Text('Entity Count: 8000', {
    font: '400 16px "Outfit", monospace',
    color: '#ff00aa',
  });

  rightStack.add(fpsText);
  rightStack.add(countText);

  // A11y Toggle
  const a11yToggle = new Toggle({
    label: 'Accessibility mode',
    checked: false,
    font: '400 14px "Outfit", sans-serif',
    color: '#fff',
    accent: '#ff00aa',
  });
  a11yToggle.on('change', (e: any) => {
    if (e.checked) {
      document.head.insertAdjacentHTML(
        'beforeend',
        '<style id="a11y-debug">div[data-vecto-id] { opacity: 1 !important; background: rgba(255,0,170,0.15) !important; border: 1px dashed #ff00aa !important; color: #fff !important; font-family: monospace; }</style>',
      );
    } else {
      document.getElementById('a11y-debug')?.remove();
    }
  });
  rightStack.add(a11yToggle);

  rightCard.add(rightStack.setPosition(24, 24));
  scene.add(rightCard.setPosition(window.innerWidth - 320, window.innerHeight / 2 - 100));

  scene.start();

  // Custom Top bar title for the Demo
  const title = document.createElement('div');
  title.style.cssText =
    'position:fixed;top:20px;left:40px;display:flex;align-items:center;gap:12px;z-index:20;font-family:"Outfit",sans-serif;pointer-events:none;';
  title.innerHTML = `
    <span style="font-weight:800;font-size:24px;color:#fff;">VectoUI</span>
    <span style="font-size:12px;padding:4px 10px;border-radius:12px;border:1px solid #00f0ff;color:#00f0ff;background:rgba(0,240,255,0.1);">Killer Demo</span>
  `;
  parent.appendChild(title);

  // FPS tracking
  let frames = 0;
  let lastTime = performance.now();
  const updateStats = () => {
    frames++;
    const now = performance.now();
    if (now - lastTime >= 1000) {
      fpsText.setText(`FPS: ${frames}`);
      countText.setText(`Entity Count: ${nexus.nodes.length}`);
      frames = 0;
      lastTime = now;
    }
    requestAnimationFrame(updateStats);
  };
  requestAnimationFrame(updateStats);

  // Responsive resize
  window.addEventListener('resize', () => {
    leftCard.y = window.innerHeight / 2 - 210;
    rightCard.x = window.innerWidth - 320;
    rightCard.y = window.innerHeight / 2 - 100;
  });
}

bootstrap();
