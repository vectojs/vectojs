import { Scene } from '@vectojs/core';
import { UIComponent } from '@vectojs/ui';

const canvas = document.getElementById('app') as HTMLCanvasElement;
canvas.width = 1920;
canvas.height = 1080;

const scene = new Scene(canvas);
(window as any).vectoScene = scene;

class EpicPromo extends UIComponent {
  time = 0;
  particles: any[] = [];

  constructor() {
    super();
    this.width = 1920;
    this.height = 1080;

    for (let i = 0; i < 250; i++) {
      this.particles.push({
        x: Math.random() * 1920,
        y: Math.random() * 1080,
        r: Math.random() * 4 + 1,
        vx: (Math.random() - 0.5) * 1.5,
        vy: (Math.random() - 0.5) * 1.5,
        hue: Math.random() * 60 + 220, // Blue/purple range
      });
    }
  }

  update(dt: number) {
    this.time += dt;
    const t = this.time / 1000;
    const speedMult = t > 120 ? 8 : t > 60 ? 3 : 1;

    for (const p of this.particles) {
      p.x += p.vx * speedMult * (dt / 16);
      p.y += p.vy * speedMult * (dt / 16);
      if (p.x < -10) p.x = 1930;
      if (p.x > 1930) p.x = -10;
      if (p.y < -10) p.y = 1090;
      if (p.y > 1090) p.y = -10;
    }
  }

  render(renderer: any) {
    const ctx = renderer.ctx as CanvasRenderingContext2D;
    const w = this.width;
    const h = this.height;
    const t = this.time / 1000;

    // 1. Deep Space Background
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#020617');
    grad.addColorStop(0.5, '#0f172a');
    grad.addColorStop(1, '#1e1b4b');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // 2. Floating Particles
    for (const p of this.particles) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${p.hue}, 100%, 70%, ${0.3 + Math.sin(t * 2 + p.x) * 0.3})`;
      ctx.fill();
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // 3. Cinematic Phases
    if (t < 60) {
      // Phase 1: Intro (0-60s)
      const alpha = Math.min(1, t / 4); // Fade in over 4s
      ctx.globalAlpha = alpha;

      // Floating Glass Card effect manually drawn
      const cardW = 900;
      const cardH = 300;
      const cardX = (w - cardW) / 2;
      const cardY = (h - cardH) / 2 + Math.sin(t * 2) * 15;

      ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(cardX, cardY, cardW, cardH, 24);
      ctx.fill();
      ctx.stroke();

      ctx.font = 'bold 120px sans-serif';
      ctx.fillStyle = '#fff';
      ctx.fillText('VectoJS UI', w / 2, cardY + 120);

      ctx.font = '40px sans-serif';
      ctx.fillStyle = '#a78bfa';
      ctx.fillText('Zero-Config Video Exporter', w / 2, cardY + 220);

      ctx.globalAlpha = 1;
    } else if (t < 120) {
      // Phase 2: Math & Curves (60-120s)
      const alpha = Math.min(1, (t - 60) / 3);
      ctx.globalAlpha = alpha;

      ctx.strokeStyle = `hsla(${(t * 15) % 360}, 100%, 65%, 0.8)`;
      ctx.lineWidth = 4;
      ctx.beginPath();
      for (let i = 0; i < Math.PI * 12; i += 0.05) {
        const x = w / 2 + Math.sin(i * 3 + t) * 500;
        const y = h / 2 + Math.cos(i * 4 + t) * 400;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      ctx.shadowColor = '#000';
      ctx.shadowBlur = 20;
      ctx.font = 'bold 100px sans-serif';
      ctx.fillStyle = '#fff';
      ctx.fillText('Deterministic Math Rendering', w / 2, h / 2);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    } else {
      // Phase 3: Hyperspeed Climax (120-180s)
      const alpha = Math.min(1, (t - 120) / 2);
      ctx.globalAlpha = alpha;

      ctx.fillStyle = `rgba(56, 189, 248, 0.15)`;
      const offset = (t * 200) % 100;
      for (let x = offset; x < w; x += 100) {
        ctx.fillRect(x, 0, 2, h);
      }
      for (let y = offset; y < h; y += 100) {
        ctx.fillRect(0, y, w, 2);
      }

      const glow = 60 + Math.sin(t * 8) * 40;
      ctx.shadowColor = `hsl(280, 100%, ${glow}%)`;
      ctx.shadowBlur = 40;

      ctx.font = 'bold 150px sans-serif';
      ctx.fillStyle = '#fff';

      const scale = 1 + Math.sin(t * 6) * 0.03;
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.scale(scale, scale);
      ctx.fillText('EXPORT COMPLETE.', 0, 0);
      ctx.restore();

      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }
  }
}

const root = new EpicPromo();
scene.add(root);
scene.start();
