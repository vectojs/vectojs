import './style.css';
import { LayoutEngine } from '@vecto/core/layout';

async function init() {
  document.querySelector('#app').innerHTML = `
    <div id="ui-layer" style="position: absolute; top: 20px; left: 20px; color: #4ade80; pointer-events: none; z-index: 10;">
      <h2>VectoUI: Official Demo Application</h2>
      <p>This is the Vite + Bun Monorepo Environment.</p>
    </div>
    <canvas id="canvas" style="display: block; width: 100vw; height: 100vh; background: #0f172a;"></canvas>
  `;

  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  
  const dpr = window.devicePixelRatio || 1;
  const resize = () => {
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    ctx.scale(dpr, dpr);
  };
  window.addEventListener('resize', resize);
  resize();

  let atlas;
  try {
    const res = await fetch('/ast/font_glyph_map.json');
    atlas = await res.json();
  } catch (e) {
    console.error("Failed to load glyph atlas.", e);
    return;
  }

  let mouseX = -1000;
  let mouseY = -1000;
  window.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
  });

  let stressMultiplier = 1;
  const baseText = "Vecto Framework Initialized. @vecto/core is running successfully. 🚀 ";
  
  window.addEventListener('keydown', (e) => {
    if (e.key === '=' || e.key === '+') stressMultiplier++;
    else if (e.key === '-' || e.key === '_') stressMultiplier = Math.max(1, stressMultiplier - 1);
  });

  let lastTime = performance.now();
  let frameCount = 0;
  let fps = 0;

  const render = (time) => {
    frameCount++;
    if (time - lastTime >= 1000) {
      fps = frameCount;
      frameCount = 0;
      lastTime = time;
    }

    const paddingX = 50;
    const paddingY = 150; 
    const layout = new LayoutEngine(window.innerWidth - paddingX * 2, window.innerHeight);
    
    const text = baseText.repeat(stressMultiplier);
    const fontSize = 28; 
    
    const result = layout.layoutText(text, atlas, fontSize);
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(paddingX, paddingY);
    
    for (const node of result.nodes) {
      const glyph = atlas[node.char];
      if (!glyph) continue;
      
      ctx.save();
      
      const dx = (node.x + paddingX) - mouseX;
      const dy = (node.y + paddingY) - mouseY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const repulsionRadius = 180;
      
      let interactiveOffsetX = 0;
      let interactiveOffsetY = 0;
      
      if (dist < repulsionRadius) {
        const force = (repulsionRadius - dist) / repulsionRadius;
        interactiveOffsetX = (dx / dist) * force * 35;
        interactiveOffsetY = (dy / dist) * force * 35;
      }

      ctx.translate(node.x + interactiveOffsetX, node.y + interactiveOffsetY);
      
      const scale = fontSize / glyph.baseSize;
      ctx.scale(scale, scale);
      
      ctx.lineWidth = 1.5 / scale;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      
      for (const path of glyph.ast.paths) {
        ctx.beginPath();
        for (const cmd of path.commands) {
          if (cmd.type === 'M') ctx.moveTo(cmd.x, cmd.y);
          else if (cmd.type === 'L') ctx.lineTo(cmd.x, cmd.y);
          else if (cmd.type === 'C') ctx.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y);
          else if (cmd.type === 'Z') ctx.closePath();
        }
        
        ctx.strokeStyle = dist < repulsionRadius ? '#38bdf8' : '#94a3b8';
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();

    drawDebugMonitor(ctx, fps, stressMultiplier, result.nodes.length);
    requestAnimationFrame(render);
  };

  requestAnimationFrame(render);
}

function drawDebugMonitor(ctx, fps, multiplier, charCount) {
  ctx.save();
  ctx.font = '14px monospace';
  ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
  
  const boxWidth = 240;
  const boxHeight = 130;
  const margin = 20;
  const x = window.innerWidth - boxWidth - margin;
  const y = margin;
  
  ctx.fillRect(x, y, boxWidth, boxHeight);
  
  if (fps >= 144) ctx.fillStyle = '#c084fc';
  else if (fps >= 60) ctx.fillStyle = '#4ade80';
  else if (fps >= 30) ctx.fillStyle = '#f97316';
  else ctx.fillStyle = '#ef4444';
  
  ctx.fillText(`FPS: ${fps} hz`, x + 15, y + 25);
  
  ctx.fillStyle = '#60a5fa';
  ctx.fillText(`Vite + @vecto/core`, x + 15, y + 45);
  ctx.fillStyle = '#fde047';
  ctx.fillText(`Multiplier: x${multiplier} [+ / -]`, x + 15, y + 65);
  ctx.fillText(`Char Count: ${charCount}`, x + 15, y + 85);
  
  ctx.fillStyle = '#cbd5e1';
  if (performance.memory) {
    const usedMB = (performance.memory.usedJSHeapSize / 1048576).toFixed(2);
    ctx.fillText(`JS Heap: ${usedMB} MB`, x + 15, y + 105);
  } else {
    ctx.fillText(`MEM: API Not Supported`, x + 15, y + 105);
  }
  ctx.restore();
}

init();
