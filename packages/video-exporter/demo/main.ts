import { Scene } from '@vectojs/core';
import { Card, Text, UIComponent } from '@vectojs/ui';

const canvas = document.getElementById('app') as HTMLCanvasElement;
canvas.width = 1280;
canvas.height = 720;

const scene = new Scene(canvas);
// Expose for video-exporter clock hijack
(window as any).vectoScene = scene;

class DemoRoot extends UIComponent {
  time = 0;
  title: Text;
  subtitle: Text;
  card: Card;

  public render(_renderer: any): void {}

  constructor() {
    super();
    this.width = 1280;
    this.height = 720;

    this.title = new Text('VectoJS Video Exporter', {
      font: 'bold 80px sans-serif',
      color: '#38bdf8',
    });
    this.title.setPosition(150, 150);

    this.subtitle = new Text('Hardware accelerated DOM-less rendering', {
      font: '32px sans-serif',
      color: '#94a3b8',
    });
    this.subtitle.setPosition(300, 250);

    this.card = new Card({
      width: 500,
      height: 200,
      bg: '#1e293b',
      radius: 16,
    });
    this.card.setPosition(390, 400);

    const cardText = new Text('Exported at 60 FPS', {
      font: 'bold 36px sans-serif',
      color: '#22c55e',
    });
    cardText.setPosition(75, 80);

    this.card.add(cardText);
    this.add(this.title);
    this.add(this.subtitle);
    this.add(this.card);
  }

  animate(dt: number) {
    this.time += dt;

    // Animate title color hue shift
    const hue = (this.time / 20) % 360;
    this.title.color = `hsl(${hue}, 100%, 60%)`;

    // Scale and rotate the card
    const scale = 1 + Math.sin(this.time / 500) * 0.05;
    this.card.scaleX = scale;
    this.card.scaleY = scale;
    this.card.rotation = Math.sin(this.time / 1000) * 0.1;
  }
}

const root = new DemoRoot();
scene.add(root);
scene.start();
