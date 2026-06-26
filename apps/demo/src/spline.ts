import { Scene, SplineEntity, loadSpline } from '@vecto-ui/core';
import { setupNavBar } from './shared/navBar';
import { setupFPSMonitor } from './shared/fpsMonitor';

if ((window as any).__VECTO_HMR_CLEANUP) {
  (window as any).__VECTO_HMR_CLEANUP();
}
let isRunning = true;
(window as any).__VECTO_HMR_CLEANUP = () => {
  isRunning = false;
};

async function bootstrap() {
  document.body.innerHTML = '';
  document.body.style.cssText = 'margin:0;overflow:hidden;background:#0f172a';

  const parent = document.createElement('div');
  parent.style.cssText = 'position:relative;width:100vw;height:100vh';
  document.body.appendChild(parent);

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;top:0;left:0';
  parent.appendChild(canvas);

  const scene = new Scene(canvas);

  // A vectomancy "Spline" document: text "Vecto" converted to math curves.
  const doc = await loadSpline('/ast/spline-vecto.json');
  // Curve-accurate picking: grab the strokes themselves (not the bounding box).
  const spline = new SplineEntity(doc, { lineWidth: 2, hitTolerance: 4 });
  spline.scaleX = 6;
  spline.scaleY = 6;
  spline.setPosition(120, 240);
  spline.interactive = true;
  scene.add(spline);

  // Drag the whole curve around.
  let dragging = false;
  let offX = 0;
  let offY = 0;
  window.addEventListener('pointerdown', (e) => {
    if (spline.isPointInside(e.clientX, e.clientY)) {
      dragging = true;
      offX = e.clientX - spline.x;
      offY = e.clientY - spline.y;
    }
  });
  window.addEventListener('pointermove', (e) => {
    if (dragging) spline.setPosition(e.clientX - offX, e.clientY - offY);
  });
  window.addEventListener('pointerup', () => (dragging = false));

  scene.start();
  setupFPSMonitor('Spline (vectomancy)', () => isRunning);
  setupNavBar('#spline');

  const hint = document.createElement('div');
  hint.style.cssText =
    'position:absolute;left:50%;bottom:40px;transform:translateX(-50%);color:#94a3b8;font:14px sans-serif;pointer-events:none';
  hint.textContent =
    'Pure math curves from vectomancy — grab a stroke to drag (curve-accurate hit-test).';
  parent.appendChild(hint);
}

bootstrap();
