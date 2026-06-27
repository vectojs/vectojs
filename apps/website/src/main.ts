import { Scene } from '@vecto-ui/core';
import { Text } from '@vecto-ui/ui';

function bootstrap() {
  document.body.innerHTML = '';
  document.body.style.cssText =
    'margin:0;overflow:hidden;background:#0a0a0f;font-family:"Outfit",sans-serif;color:#fff';

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;top:0;left:0;width:100vw;height:100vh;z-index:1';
  document.body.appendChild(canvas);

  const scene = new Scene(canvas, { pointBackend: 'webgl' });

  const title = new Text('VectoUI Official Website', {
    font: '800 48px "Outfit", sans-serif',
    color: '#00f0ff',
  });
  scene.add(title.setPosition(40, 60));

  const subtitle = new Text(
    'Scaffolding created. Claude Code, please build the router and pages here!',
    {
      font: '400 24px "Outfit", sans-serif',
      color: '#fff',
    },
  );
  scene.add(subtitle.setPosition(40, 120));

  scene.start();

  window.addEventListener('resize', () => {
    // handled by Scene
  });
}

bootstrap();
