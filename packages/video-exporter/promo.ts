import { Scene } from '@vectojs/core';
import { Card, Text, UIComponent } from '@vectojs/ui';

const canvas = document.getElementById('app') as HTMLCanvasElement;
canvas.width = 1920;
canvas.height = 1080;

const scene = new Scene(canvas);
(window as any).vectoScene = scene;

class PromoRoot extends UIComponent {
  time = 0;
  particles: UIComponent[] = [];
  glassCard: Card;
  logoText: Text;

  public render(renderer: any): void {}

  constructor() {
    super();
    this.width = 1920;
    this.height = 1080;

    // Background gradient using VectoJS styling properties
    this.bg = 'linear-gradient(135deg, #020617, #0f172a, #1e1b4b)';

    // Floating particles
    for (let i = 0; i < 50; i++) {
      const p = new UIComponent();
      p.render = () => {}; // Fix render crash
      p.width = Math.random() * 10 + 5;
      p.height = p.width;
      p.bg = `rgba(139, 92, 246, ${Math.random() * 0.5 + 0.1})`;
      p.radius = p.width / 2;
      p.setPosition(Math.random() * 1920, Math.random() * 1080);
      (p as any).vx = (Math.random() - 0.5) * 2;
      (p as any).vy = (Math.random() - 0.5) * 2;
      this.particles.push(p);
      this.add(p);
    }

    // Center Glassmorphism Card
    this.glassCard = new Card({
      width: 800,
      height: 400,
      bg: 'rgba(255, 255, 255, 0.05)',
      radius: 30,
    });
    this.glassCard.setPosition((1920 - 800) / 2, (1080 - 400) / 2);
    // Note: VectoJS supports CSS-like backdrop filters if configured,
    // but we use generic properties for safety.

    this.logoText = new Text('VectoJS UI', {
      font: 'bold 120px "Inter", sans-serif',
      color: '#fff',
    });
    this.logoText.setPosition(120, 80);

    const subText = new Text('Zero-Config Video Exporter', {
      font: '50px "Inter", sans-serif',
      color: '#a78bfa',
    });
    subText.setPosition(90, 240);

    this.glassCard.add(this.logoText);
    this.glassCard.add(subText);
    this.add(this.glassCard);
  }

  animate(dt: number) {
    this.time += dt;

    // Particle motion
    for (const p of this.particles) {
      const x = p.x + (p as any).vx;
      const y = p.y + (p as any).vy;
      p.setPosition(x < 0 ? 1920 : x > 1920 ? 0 : x, y < 0 ? 1080 : y > 1080 ? 0 : y);
    }

    // Glass Card float effect (Sine wave)
    const cardY = (1080 - 400) / 2 + Math.sin(this.time / 800) * 20;
    this.glassCard.setPosition((1920 - 800) / 2, cardY);

    // Pulse glow effect on text
    const glow = 60 + Math.sin(this.time / 400) * 40;
    this.logoText.color = `hsl(260, 100%, ${glow}%)`;
  }
}

const root = new PromoRoot();
scene.add(root);
scene.start();
