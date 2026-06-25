import { Scene } from '@vecto-ui/core';
import { Text, Button, Link } from '@vecto-ui/ui';
import { setupNavBar } from './shared/navBar';
import { setupFPSMonitor } from './shared/fpsMonitor';

if ((window as any).__VECTO_HMR_CLEANUP) {
  (window as any).__VECTO_HMR_CLEANUP();
}
let isRunning = true;
(window as any).__VECTO_HMR_CLEANUP = () => {
  isRunning = false;
};

function bootstrap() {
  document.body.innerHTML = '';
  document.body.style.cssText = 'margin:0;overflow:hidden;background:#0f172a';

  const parent = document.createElement('div');
  parent.style.cssText = 'position:relative;width:100vw;height:100vh';
  document.body.appendChild(parent);

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;top:0;left:0';
  parent.appendChild(canvas);

  const scene = new Scene(canvas);

  scene.add(
    new Text('VectoUI components — rendered to canvas, accessible & agent-clickable.', {
      font: '20px sans-serif',
      color: '#e2e8f0',
      maxWidth: 600,
      lineHeight: 28,
    }).setPosition(60, 80),
  );

  let count = 0;
  const counter = new Text('Clicked 0 times', {
    font: '16px sans-serif',
    color: '#94a3b8',
  }).setPosition(60, 260);
  scene.add(counter);

  scene.add(
    new Button('Click me', {
      onClick: () => {
        count++;
        counter.setText(`Clicked ${count} times`);
      },
    }).setPosition(60, 180),
  );

  scene.add(
    new Link('Open the VectoUI repo', { href: 'https://github.com/Xuepoo/vecto-ui' }).setPosition(
      60,
      320,
    ),
  );

  scene.start();
  setupFPSMonitor('UI Components', () => isRunning);
  setupNavBar('#ui-components');
}

bootstrap();
