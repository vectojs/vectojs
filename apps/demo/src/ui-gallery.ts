import { Scene } from '@vecto-ui/core';
import { Text, Button, Link, Card, Stack, Input, Checkbox, Toggle, Image } from '@vecto-ui/ui';
import { setupNavBar } from './shared/navBar';
import { setupFPSMonitor } from './shared/fpsMonitor';

if ((window as any).__VECTO_HMR_CLEANUP) {
  (window as any).__VECTO_HMR_CLEANUP();
}
let isRunning = true;
(window as any).__VECTO_HMR_CLEANUP = () => {
  isRunning = false;
};

/**
 * Gallery of every @vecto-ui/ui primitive in one canvas — also the page used for
 * visual (browser screenshot) verification and for the agent-driven form demo
 * (each control projects a real shadow node).
 */
function bootstrap() {
  document.body.innerHTML = '';
  document.body.style.cssText = 'margin:0;overflow:hidden;background:#0b1020';

  const parent = document.createElement('div');
  parent.style.cssText = 'position:relative;width:100vw;height:100vh';
  document.body.appendChild(parent);

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;top:0;left:0';
  parent.appendChild(canvas);

  // onDemand: this is a static/event-driven UI, so it idles at ~0 cost.
  const scene = new Scene(canvas, { pointBackend: 'canvas' });
  scene.renderMode = 'onDemand';
  const repaint = () => scene.markDirty();

  // --- Left column: typography + links ---
  const left = new Stack({ direction: 'vertical', gap: 16 });
  left.add(new Text('VectoUI Components', { font: '700 28px sans-serif', color: '#f8fafc' }));
  left.add(
    new Text(
      'Every control below is pure Canvas — and every one projects a real DOM\nshadow node, so Playwright / agents can drive it by role.',
      {
        font: '15px sans-serif',
        color: '#94a3b8',
        maxWidth: 420,
        lineHeight: 22,
      },
    ),
  );
  left.add(new Link('Read the docs →', { href: 'https://github.com/Xuepoo/vecto-ui' }));
  left.add(
    new Button('Primary action', { onClick: () => console.log('[gallery] primary clicked') }),
  );
  scene.add(left.setPosition(48, 48));

  // --- Right column: a form inside a card ---
  const form = new Stack({ direction: 'vertical', gap: 18 });
  form.add(new Text('Sign up', { font: '600 20px sans-serif', color: '#e2e8f0' }));
  form.add(new Input({ width: 300, placeholder: 'you@example.com', onChange: repaint }));
  form.add(new Input({ width: 300, placeholder: 'Password', onChange: repaint }));
  form.add(new Checkbox({ label: 'I accept the terms', onChange: repaint }));
  form.add(new Toggle({ label: 'Subscribe to updates', checked: true, onChange: repaint }));
  form.add(new Button('Create account', { onClick: () => console.log('[gallery] submit') }));

  const card = new Card({ width: 360, height: 320, border: '#334155', padding: 24 });
  card.add(form.setPosition(24, 24));
  scene.add(card.setPosition(520, 48));

  // --- Image primitive ---
  const img = new Image('https://placehold.co/120x40/1e293b/38bdf8/png?text=Vecto', {
    width: 120,
    height: 40,
    alt: 'Vecto logo',
    onLoad: repaint,
  });
  scene.add(img.setPosition(48, 320));

  scene.start();
  setupFPSMonitor('UI Gallery (onDemand)', () => isRunning);
  setupNavBar('#ui-gallery');
}

bootstrap();
