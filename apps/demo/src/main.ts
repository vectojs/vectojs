import { Scene } from '@vecto-ui/core';
import {
  Card,
  Stack,
  Text,
  Toggle,
  Button,
  Input,
  Markdown,
  ScrollView,
  Dropdown,
  Slider,
  Modal,
} from '@vecto-ui/ui';
import { NexusGraph } from './nexus/NexusGraph';
import { ThreeRenderer } from '@vecto-ui/three';
import * as THREE from 'three';

let currentScene: any = null;
let currentResizeHandler: (() => void) | null = null;
let currentMouseMoveHandler: (() => void) | null = null;
let currentAnimationFrame: number | null = null;

// CSS for backend switcher
const switcherStyle = document.createElement('style');
switcherStyle.innerHTML = `
  .backend-selector {
    position: fixed;
    top: 20px;
    right: 40px;
    display: flex;
    gap: 8px;
    z-index: 100;
    font-family: 'Outfit', sans-serif;
  }
  .backend-btn {
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.15);
    color: rgba(255, 255, 255, 0.6);
    padding: 8px 16px;
    border-radius: 20px;
    cursor: pointer;
    font-size: 14px;
    font-weight: 600;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    backdrop-filter: blur(10px);
  }
  .backend-btn:hover {
    background: rgba(255, 255, 255, 0.15);
    color: #fff;
    border-color: rgba(255, 255, 255, 0.3);
  }
  .backend-btn.active {
    background: linear-gradient(135deg, #00f0ff, #aa3bff);
    color: #fff;
    border-color: transparent;
    box-shadow: 0 0 15px rgba(0, 240, 255, 0.4);
  }
`;
document.head.appendChild(switcherStyle);

function cleanup() {
  if (currentScene) {
    currentScene.destroy();
    currentScene = null;
  }
  if (currentResizeHandler) {
    window.removeEventListener('resize', currentResizeHandler);
    currentResizeHandler = null;
  }
  if (currentMouseMoveHandler) {
    window.removeEventListener('mousemove', currentMouseMoveHandler);
    currentMouseMoveHandler = null;
  }
  if (currentAnimationFrame !== null) {
    cancelAnimationFrame(currentAnimationFrame);
    currentAnimationFrame = null;
  }

  // Clean up any extra style tags added in demo
  document.getElementById('a11y-debug')?.remove();

  const container = document.getElementById('demo-container');
  if (container) {
    container.remove();
  }
}

function initCanvasDemo() {
  cleanup();

  document.body.style.cssText =
    'margin:0;overflow:hidden;background:#0a0a0f;font-family:"Outfit",sans-serif;color:#fff';

  const parent = document.createElement('div');
  parent.id = 'demo-container';
  parent.style.cssText = 'position:relative;width:100vw;height:100vh';
  document.body.appendChild(parent);

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;top:0;left:0;width:100vw;height:100vh;z-index:1';
  parent.appendChild(canvas);

  const scene = new Scene(canvas, { pointBackend: 'webgl' });
  currentScene = scene;

  const nexus = new NexusGraph(15000); // 15,000 nodes
  scene.add(nexus);

  // Left Panel - Glassmorphism UI
  const leftCard = new Card({
    width: 320,
    height: 620,
    bg: 'rgba(20, 20, 30, 0.65)',
    border: 'rgba(255, 255, 255, 0.1)',
    padding: 24,
    radius: 16,
  });
  const leftStack = new Stack({ direction: 'vertical', gap: 14 });
  leftStack.add(
    new Text('Glassmorphism', { font: '600 24px "Outfit", sans-serif', color: '#fff' }),
  );
  const searchInput = new Input({
    width: 272,
    placeholder: 'Search node index (e.g. 404)...',
    font: '400 15px "Outfit", sans-serif',
    bg: 'rgba(0,0,0,0.4)',
    border: 'rgba(255,255,255,0.1)',
    color: '#fff',
    radius: 8,
  });
  searchInput.on('change', (e: any) => {
    const val = parseInt(e.value);
    if (!isNaN(val) && val >= 0 && val < nexus.nodes.length) {
      nexus.setHighlight(val);
    } else {
      nexus.setHighlight(-1); // Clear
    }
  });
  leftStack.add(searchInput);

  const physicsToggle = new Toggle({
    label: 'Physics Engine',
    checked: true,
    font: '400 14px "Outfit", sans-serif',
    color: '#fff',
    accent: '#00f0ff',
    onChange: (checked) => {
      nexus.physicsEnabled = checked;
    },
  });
  leftStack.add(physicsToggle);

  const btnRow = new Stack({ direction: 'horizontal', gap: 12 });
  const spawnPlusBtn = new Button('+ 1000 Nodes', {
    bg: 'rgba(0, 240, 255, 0.2)',
    hoverBg: 'rgba(0, 240, 255, 0.4)',
    color: '#00f0ff',
    radius: 8,
    font: '600 14px "Outfit", sans-serif',
  });
  spawnPlusBtn.on('click', () => {
    nexus.addNodes(1000);
    nodeCountSlider.value = nexus.nodes.length;
    sliderLabel.setText(`Nodes: ${nexus.nodes.length}`);
  });

  const spawnMinusBtn = new Button('- 1000 Nodes', {
    bg: 'rgba(255, 0, 170, 0.2)',
    hoverBg: 'rgba(255, 0, 170, 0.4)',
    color: '#ff00aa',
    radius: 8,
    font: '600 14px "Outfit", sans-serif',
  });
  spawnMinusBtn.on('click', () => {
    nexus.removeNodes(1000);
    nodeCountSlider.value = nexus.nodes.length;
    sliderLabel.setText(`Nodes: ${nexus.nodes.length}`);
  });

  btnRow.add(spawnPlusBtn);
  btnRow.add(spawnMinusBtn);
  leftStack.add(btnRow);

  // Dropdown for Theme
  const themeDropdown = new Dropdown(['Cyberpunk', 'Matrix', 'Fire', 'Monochrome'], {
    width: 272,
    height: 36,
    value: 'Cyberpunk',
    bg: 'rgba(255, 255, 255, 0.1)',
    font: '600 14px "Outfit", sans-serif',
    radius: 8,
  });
  themeDropdown.on('change', (e: any) => {
    nexus.changeTheme(e.value);
  });
  leftStack.add(themeDropdown);

  let isTextShape = false;
  const shapeBtn = new Button('Shape: Circle', {
    bg: 'rgba(255, 255, 255, 0.1)',
    hoverBg: 'rgba(255, 255, 255, 0.2)',
    color: '#ffffff',
    radius: 8,
    font: '600 14px "Outfit", sans-serif',
  });
  shapeBtn.width = 272;
  shapeBtn.on('click', () => {
    isTextShape = !isTextShape;
    shapeBtn.label = isTextShape ? 'Shape: @ Text' : 'Shape: Circle';
    nexus.changeShape(isTextShape ? 'text' : 'circle');
  });
  leftStack.add(shapeBtn);

  // Slider for Node Count
  const sliderLabel = new Text('Nodes: 15000', {
    font: '600 13px "Outfit", sans-serif',
    color: 'rgba(255, 255, 255, 0.7)',
  });
  leftStack.add(sliderLabel);

  const nodeCountSlider = new Slider({
    min: 1000,
    max: 30000,
    value: 15000,
    width: 272,
    height: 24,
    progressColor: '#00f0ff',
  });
  nodeCountSlider.on('change', (e: any) => {
    const targetCount = e.value;
    sliderLabel.setText(`Nodes: ${targetCount}`);
    const currentCount = nexus.nodes.length;
    if (targetCount > currentCount) {
      nexus.addNodes(targetCount - currentCount);
    } else if (targetCount < currentCount) {
      nexus.removeNodes(currentCount - targetCount);
    }
  });
  leftStack.add(nodeCountSlider);

  // Info Button for Modal popup
  const infoBtn = new Button('Show VectoUI Info', {
    bg: 'rgba(0, 240, 255, 0.2)',
    hoverBg: 'rgba(0, 240, 255, 0.4)',
    color: '#00f0ff',
    radius: 8,
    font: '600 14px "Outfit", sans-serif',
  });
  infoBtn.width = 272;
  infoBtn.on('click', () => {
    const modal = new Modal('VectoUI Info', {
      modalWidth: 420,
      modalHeight: 280,
      cardBg: 'rgba(20, 20, 35, 0.95)',
      cardBorder: 'rgba(0, 240, 255, 0.3)',
    });
    const descText = new Text(
      'A high-performance vector rendering UI framework driven by zero-DOM Math Tree, supporting Canvas 2D and WebGL backends.',
      {
        font: '14px "Outfit", sans-serif',
        color: 'rgba(255, 255, 255, 0.7)',
      },
    );
    descText.width = 372;
    modal.card.add(descText.setPosition(24, 80));
    scene.showOverlay(modal);
  });
  leftStack.add(infoBtn);

  leftCard.add(leftStack.setPosition(24, 24));
  scene.add(leftCard.setPosition(40, window.innerHeight / 2 - 310));

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
  const countText = new Text('Entity Count: 15000', {
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
    onChange: (checked) => {
      if (checked) {
        document.head.insertAdjacentHTML(
          'beforeend',
          '<style id="a11y-debug">*[data-vecto-id] { opacity: 1 !important; background: rgba(255,0,170,0.15) !important; border: 1px dashed #ff00aa !important; color: #fff !important; font-family: monospace; }</style>',
        );
      } else {
        document.getElementById('a11y-debug')?.remove();
      }
    },
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
    <span style="font-size:12px;padding:4px 10px;border-radius:12px;border:1px solid #00f0ff;color:#00f0ff;background:rgba(0,240,255,0.1);">Canvas Mode</span>
  `;
  parent.appendChild(title);

  // FPS tracking
  let frames = 0;
  let lastTime = performance.now();
  const updateStats = () => {
    if (!currentScene || currentScene !== scene) return;
    frames++;
    const now = performance.now();
    if (now - lastTime >= 1000) {
      fpsText.setText(`FPS: ${frames}`);
      countText.setText(`Entity Count: ${nexus.nodes.length}`);
      frames = 0;
      lastTime = now;
    }
    currentAnimationFrame = requestAnimationFrame(updateStats);
  };
  currentAnimationFrame = requestAnimationFrame(updateStats);

  // Responsive resize
  const resizeHandler = () => {
    leftCard.y = window.innerHeight / 2 - 310;
    rightCard.x = window.innerWidth - 320;
    rightCard.y = window.innerHeight / 2 - 100;
  };
  window.addEventListener('resize', resizeHandler);
  currentResizeHandler = resizeHandler;
}

function initThreeDemo() {
  cleanup();

  document.body.style.cssText =
    'margin:0;overflow:hidden;background:#030014;font-family:"Outfit",sans-serif;color:#fff';

  const parent = document.createElement('div');
  parent.id = 'demo-container';
  parent.style.cssText = 'position:relative;width:100vw;height:100vh;perspective:1000px;';
  document.body.appendChild(parent);

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;top:0;left:0;width:100vw;height:100vh;z-index:1';
  parent.appendChild(canvas);

  // Initialize WebGL/Three.js Renderer!
  const threeRenderer = new ThreeRenderer(canvas);
  const scene = new Scene(canvas, { renderer: threeRenderer });
  currentScene = scene;

  // Custom 3D Background element - TorusKnot
  const geometry = new THREE.TorusKnotGeometry(120, 35, 150, 16);
  const material = new THREE.MeshNormalMaterial({
    wireframe: true,
    transparent: true,
    opacity: 0.35,
  });
  const torusKnot = new THREE.Mesh(geometry, material);
  torusKnot.position.set(window.innerWidth / 2, window.innerHeight / 2, -200);
  threeRenderer.scene.add(torusKnot);

  // Glassmorphic Control panel
  const mainCard = new Card({
    width: 480,
    height: 640,
    bg: 'rgba(15, 15, 30, 0.7)',
    border: 'rgba(0, 240, 255, 0.25)',
    padding: 24,
    radius: 20,
  });

  const layoutStack = new Stack({ direction: 'vertical', gap: 16 });

  // Title
  layoutStack.add(
    new Text('WebGL 2.5D Renderer', { font: '800 26px "Outfit", sans-serif', color: '#00f0ff' }),
  );

  // Description inside ScrollView (uses Markdown!)
  const scroll = new ScrollView({
    width: 432,
    height: 280,
    contentWidth: 432,
    contentHeight: 560,
  });

  const mdContent = `
# VectoUI + Three.js Backend
Rendered inside **WebGL** with 60 FPS hardware acceleration.

## Multi-color Syntax Highlighting
\`\`\`ts
const renderer = new ThreeRenderer(canvas);
const scene = new Scene(canvas, { renderer });
scene.start();
\`\`\`

## Advanced 3D Effects
- Fully GPU Accelerated via ThreeJS
- Zero-DOM Virtual Math Tree (VMT) architecture
- Responsive glassmorphism panels & flexbox layouts
- Interactive components: Buttons, Inputs, Toggles
`;

  const md = new Markdown(mdContent, {
    width: 410,
    fontFamily: '"Outfit", sans-serif',
  });
  scroll.add(md);
  layoutStack.add(scroll);

  // Bottom interactive strip
  const controlsRow = new Stack({ direction: 'horizontal', gap: 16 });

  let isRotating = true;
  const rotToggle = new Toggle({
    label: 'Background Rotation',
    checked: true,
    font: '600 13px "Outfit", sans-serif',
    color: '#fff',
    accent: '#00f0ff',
    onChange: (checked) => {
      isRotating = checked;
    },
  });
  controlsRow.add(rotToggle);

  // Dropdown replaces pulseBtn
  const scaleDropdown = new Dropdown(['1.0x', '1.5x', '2.0x'], {
    width: 100,
    height: 36,
    value: '1.0x',
    font: '600 13px "Outfit", sans-serif',
    bg: 'rgba(170, 59, 255, 0.15)',
    color: '#c084fc',
    radius: 10,
  });
  scaleDropdown.on('change', (e: any) => {
    const scale = parseFloat(e.value);
    torusKnot.scale.set(scale, scale, scale);
  });
  controlsRow.add(scaleDropdown);

  // Info button that triggers Modal
  const infoBtn = new Button('Info', {
    bg: 'rgba(255, 255, 255, 0.1)',
    hoverBg: 'rgba(255, 255, 255, 0.2)',
    color: '#ffffff',
    radius: 10,
    font: '600 13px "Outfit", sans-serif',
  });
  infoBtn.width = 80;
  infoBtn.on('click', () => {
    const modal = new Modal('WebGL 3D Context', {
      modalWidth: 420,
      modalHeight: 280,
      cardBg: 'rgba(15, 15, 30, 0.95)',
      cardBorder: 'rgba(170, 59, 255, 0.4)',
    });
    const descText = new Text(
      'VectoUI operates seamlessly alongside Three.js. Standard input controls are bound directly onto the Three.js viewport, utilizing unclipped float mapping.',
      {
        font: '14px "Outfit", sans-serif',
        color: 'rgba(255, 255, 255, 0.7)',
      },
    );
    descText.width = 372;
    modal.card.add(descText.setPosition(24, 80));
    scene.showOverlay(modal);
  });
  controlsRow.add(infoBtn);

  layoutStack.add(controlsRow);

  // Speed Slider
  const speedLabel = new Text('Rotation Speed: 1.0x', {
    font: '600 13px "Outfit", sans-serif',
    color: '#fff',
  });
  layoutStack.add(speedLabel);

  let rotationSpeedFactor = 1.0;
  const speedSlider = new Slider({
    min: 0,
    max: 300,
    value: 100,
    width: 432,
    height: 24,
    progressColor: '#aa3bff',
  });
  speedSlider.on('change', (e: any) => {
    rotationSpeedFactor = e.value / 100;
    speedLabel.setText(`Rotation Speed: ${rotationSpeedFactor.toFixed(1)}x`);
  });
  layoutStack.add(speedSlider);

  mainCard.add(layoutStack.setPosition(24, 24));
  scene.add(mainCard.setPosition(window.innerWidth / 2 - 240, window.innerHeight / 2 - 320));

  // Small instructions box
  const tipText = new Text('Move mouse around screen to rotate the entire 3D Scene', {
    font: '400 13px "Outfit", sans-serif',
    color: 'rgba(255, 255, 255, 0.4)',
  });
  scene.add(tipText.setPosition(window.innerWidth / 2 - 160, window.innerHeight - 60));

  // A11y toggle
  const a11yToggle = new Toggle({
    label: 'Accessibility Mode',
    checked: false,
    font: '400 13px "Outfit", sans-serif',
    color: 'rgba(255,255,255,0.6)',
    accent: '#aa3bff',
    onChange: (checked) => {
      if (checked) {
        document.head.insertAdjacentHTML(
          'beforeend',
          '<style id="a11y-debug">*[data-vecto-id] { opacity: 1 !important; background: rgba(255,0,170,0.15) !important; border: 1px dashed #ff00aa !important; color: #fff !important; font-family: monospace; }</style>',
        );
      } else {
        document.getElementById('a11y-debug')?.remove();
      }
    },
  });
  scene.add(a11yToggle.setPosition(40, window.innerHeight - 60));

  scene.start();

  // Custom Top bar title for the Demo
  const title = document.createElement('div');
  title.style.cssText =
    'position:fixed;top:20px;left:40px;display:flex;align-items:center;gap:12px;z-index:20;font-family:"Outfit",sans-serif;pointer-events:none;';
  title.innerHTML = `
    <span style="font-weight:800;font-size:24px;color:#fff;">VectoUI</span>
    <span style="font-size:12px;padding:4px 10px;border-radius:12px;border:1px solid #aa3bff;color:#c084fc;background:rgba(170,59,255,0.1);">WebGL Mode</span>
  `;
  parent.appendChild(title);

  // 2.5D Mouse Interaction
  let targetRotX = 0;
  let targetRotY = 0;
  const onMouseMove = (e: MouseEvent) => {
    const nx = (e.clientX / window.innerWidth) * 2 - 1;
    const ny = (e.clientY / window.innerHeight) * 2 - 1;
    targetRotY = nx * 0.15;
    targetRotX = -ny * 0.12;
  };
  window.addEventListener('mousemove', onMouseMove);
  currentMouseMoveHandler = onMouseMove;

  const tick = () => {
    if (!currentScene || currentScene !== scene) return;
    if (isRotating) {
      torusKnot.rotation.x += 0.005 * rotationSpeedFactor;
      torusKnot.rotation.y += 0.008 * rotationSpeedFactor;
    }
    // Smooth interpolation for 2.5D mouse effect
    threeRenderer.scene.rotation.y += (targetRotY - threeRenderer.scene.rotation.y) * 0.05;
    threeRenderer.scene.rotation.x += (targetRotX - threeRenderer.scene.rotation.x) * 0.05;

    currentAnimationFrame = requestAnimationFrame(tick);
  };
  currentAnimationFrame = requestAnimationFrame(tick);

  // Resize handler
  const resizeHandler = () => {
    torusKnot.position.set(window.innerWidth / 2, window.innerHeight / 2, -200);
    mainCard.x = window.innerWidth / 2 - 240;
    mainCard.y = window.innerHeight / 2 - 320;
    tipText.x = window.innerWidth / 2 - 160;
    tipText.y = window.innerHeight - 60;
    a11yToggle.y = window.innerHeight - 60;
  };
  window.addEventListener('resize', resizeHandler);
  currentResizeHandler = resizeHandler;
}

class DashboardParticle extends Entity {
  public vx: number;
  public vy: number;
  constructor(
    public radius: number,
    public color: string,
  ) {
    super();
    this.vx = (Math.random() - 0.5) * 300;
    this.vy = (Math.random() - 0.5) * 300;
  }
  isPointInside(): boolean {
    return false;
  }
  getBatchCircle() {
    return { radius: this.radius, color: this.color };
  }
  render(r: IRenderer): void {
    r.beginPath();
    r.arc(0, 0, this.radius, 0, Math.PI * 2);
    r.fill(this.color);
  }
}

class DashboardChartEntity extends Entity {
  public fpsData: number[] = [];
  public maxPoints: number = 60;

  constructor(
    public width: number,
    public height: number,
  ) {
    super();
  }

  public pushData(val: number) {
    this.fpsData.push(val);
    if (this.fpsData.length > this.maxPoints) {
      this.fpsData.shift();
    }
  }

  isPointInside(): boolean {
    return false;
  }

  render(r: IRenderer): void {
    // Background Grid
    r.beginPath();
    r.save();
    r.translate(this.x, this.y);

    // Draw grid lines
    for (let i = 0; i <= 4; i++) {
      const cy = (this.height / 4) * i;
      r.beginPath();
      r.moveTo(0, cy);
      r.lineTo(this.width, cy);
      r.stroke('rgba(255, 255, 255, 0.08)', 1);
    }

    if (this.fpsData.length < 2) {
      r.restore();
      return;
    }

    // Draw glowing line chart
    const maxVal = 160; // Max coordinate 160fps
    const getX = (idx: number) => (idx / (this.maxPoints - 1)) * this.width;
    const getY = (val: number) => this.height - (Math.min(val, maxVal) / maxVal) * this.height;

    r.beginPath();
    r.moveTo(getX(0), getY(this.fpsData[0]));
    for (let i = 1; i < this.fpsData.length; i++) {
      r.lineTo(getX(i), getY(this.fpsData[i]));
    }
    r.stroke('#00f0ff', 3); // Neon blue line

    // Semi-transparent area fill
    r.lineTo(getX(this.fpsData.length - 1), this.height);
    r.lineTo(getX(0), this.height);
    r.closePath();
    r.fill('rgba(0, 240, 255, 0.12)');

    // Active indicator point at the end
    const lastIdx = this.fpsData.length - 1;
    const lastVal = this.fpsData[lastIdx];
    r.beginPath();
    r.arc(getX(lastIdx), getY(lastVal), 5, 0, Math.PI * 2);
    r.fill('#00f0ff');
    r.stroke('#ffffff', 2);

    r.restore();
  }
}

function initDashboardDemo() {
  cleanup();

  document.body.style.cssText =
    'margin:0;overflow:hidden;background:#030014;font-family:"Outfit",sans-serif;color:#fff';

  const parent = document.createElement('div');
  parent.id = 'demo-container';
  parent.style.cssText = 'position:relative;width:100vw;height:100vh';
  document.body.appendChild(parent);

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;top:0;left:0;width:100vw;height:100vh;z-index:1';
  parent.appendChild(canvas);

  let pointBackend: 'webgl' | 'canvas' = 'canvas';
  let particleCount = 10000;
  const particles: DashboardParticle[] = [];
  let isBenchmarking = false;

  const scene = new Scene(canvas, pointBackend === 'webgl' ? { pointBackend: 'webgl' } : {});
  currentScene = scene;

  // Custom Title
  const title = document.createElement('div');
  title.style.cssText =
    'position:fixed;top:20px;left:40px;display:flex;align-items:center;gap:12px;z-index:20;font-family:"Outfit",sans-serif;pointer-events:none;';
  title.innerHTML = `
    <span style="font-weight:800;font-size:24px;color:#fff;">VectoUI</span>
    <span style="font-size:12px;padding:4px 10px;border-radius:12px;border:1px solid #00f0ff;color:#00f0ff;background:rgba(0,240,255,0.1);">Performance Lab</span>
  `;
  parent.appendChild(title);

  // 1. Control Panel Card (Left Panel)
  const controlCard = new Card({
    width: 320,
    height: 520,
    bg: 'rgba(15, 15, 25, 0.75)',
    border: 'rgba(255, 255, 255, 0.1)',
    padding: 24,
    radius: 16,
  });

  const controlStack = new Stack({ direction: 'vertical', gap: 16 });
  controlStack.add(
    new Text('Test Settings', { font: '600 22px "Outfit", sans-serif', color: '#fff' }),
  );

  // Backend selection dropdown
  controlStack.add(
    new Text('Renderer Backend', {
      font: '600 13px "Outfit", sans-serif',
      color: 'rgba(255,255,255,0.5)',
    }),
  );
  const backendDropdown = new Dropdown(['Canvas 2D (Batching)', 'WebGL Point Cloud'], {
    width: 272,
    height: 36,
    value: 'Canvas 2D (Batching)',
    bg: 'rgba(255, 255, 255, 0.1)',
    font: '600 13px "Outfit", sans-serif',
    radius: 8,
  });
  backendDropdown.on('change', (e: any) => {
    pointBackend = e.value.startsWith('WebGL') ? 'webgl' : 'canvas';
  });
  controlStack.add(backendDropdown);

  // Particle count slider
  const sliderLabel = new Text('Particle Entities: 10000', {
    font: '600 13px "Outfit", sans-serif',
    color: 'rgba(255,255,255,0.5)',
  });
  controlStack.add(sliderLabel);
  const countSlider = new Slider({
    min: 1000,
    max: 50000,
    value: 10000,
    width: 272,
    height: 24,
    progressColor: '#00f0ff',
  });
  countSlider.on('change', (e: any) => {
    particleCount = e.value;
    sliderLabel.setText(`Particle Entities: ${particleCount}`);
  });
  controlStack.add(countSlider);

  // Benchmark toggle action
  const toggleBtn = new Button('Run Benchmark Simulation', {
    bg: 'linear-gradient(135deg, #00f0ff, #aa3bff)',
    hoverBg: 'linear-gradient(135deg, #33f3ff, #be63ff)',
    color: '#fff',
    radius: 10,
    font: '600 14px "Outfit", sans-serif',
  });
  toggleBtn.width = 272;
  toggleBtn.height = 42;

  toggleBtn.on('click', () => {
    if (isBenchmarking) {
      // Stop
      isBenchmarking = false;
      toggleBtn.label = 'Run Benchmark Simulation';
      // Remove all particles
      for (const p of particles) {
        scene.remove(p);
      }
      particles.length = 0;
    } else {
      // Start
      isBenchmarking = true;
      toggleBtn.label = 'Stop Simulation';

      // Re-initialize Scene with selected backend if WebGL is requested
      scene.destroy();
      const newScene = new Scene(canvas, pointBackend === 'webgl' ? { pointBackend: 'webgl' } : {});
      currentScene = newScene;

      // Add UI controls back onto the new scene tree
      newScene.add(controlCard);
      newScene.add(statsCard);

      // Spawn particles
      const colors = ['#00f0ff', '#ff00aa', '#aa3bff', '#ffffff', '#38bdf8'];
      for (let i = 0; i < particleCount; i++) {
        const color = colors[i % colors.length];
        const p = new DashboardParticle(Math.max(1.5, Math.random() * 3.5), color);
        p.setPosition(Math.random() * window.innerWidth, Math.random() * window.innerHeight);
        particles.push(p);
        newScene.add(p);
      }

      newScene.start();
    }
  });
  controlStack.add(toggleBtn);

  controlCard.add(controlStack.setPosition(24, 24));
  scene.add(controlCard.setPosition(40, window.innerHeight / 2 - 260));

  // 2. Metrics & Chart Panel Card (Right Panel)
  const statsCard = new Card({
    width: 480,
    height: 520,
    bg: 'rgba(15, 15, 25, 0.75)',
    border: 'rgba(255, 255, 255, 0.1)',
    padding: 24,
    radius: 16,
  });

  const statsStack = new Stack({ direction: 'vertical', gap: 14 });
  statsStack.add(
    new Text('Engine Diagnostics', { font: '600 22px "Outfit", sans-serif', color: '#fff' }),
  );

  const metricsRow = new Stack({ direction: 'horizontal', gap: 20 });
  const fpsLabel = new Text('FPS: --', { font: '600 18px "Outfit", monospace', color: '#00f0ff' });
  const latencyLabel = new Text('Frame Cost: -- ms', {
    font: '600 18px "Outfit", monospace',
    color: '#ff00aa',
  });
  metricsRow.add(fpsLabel);
  metricsRow.add(latencyLabel);
  statsStack.add(metricsRow);

  // Add the custom live line chart entity
  const chart = new DashboardChartEntity(432, 260);
  statsStack.add(chart.setPosition(0, 0));

  const gcText = new Text('Memory Footprint: -- MB (Zero-GC Mode)', {
    font: '400 13px "Outfit", sans-serif',
    color: 'rgba(255, 255, 255, 0.4)',
  });
  statsStack.add(gcText);

  statsCard.add(statsStack.setPosition(24, 24));
  scene.add(statsCard.setPosition(window.innerWidth - 520, window.innerHeight / 2 - 260));

  scene.start();

  // Metrics update tick loop
  let frames = 0;
  let lastTime = performance.now();
  let lastFrameTime = performance.now();

  const tickStats = () => {
    if (!currentScene || currentScene !== scene) return;

    frames++;
    const now = performance.now();
    const dt = now - lastFrameTime;
    lastFrameTime = now;

    // Simulate simple particle physics bounds check if benchmark is running
    if (isBenchmarking) {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const dtSec = Math.min(0.032, dt / 1000);
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.x += p.vx * dtSec;
        p.y += p.vy * dtSec;
        if (p.x < 0) {
          p.x = 0;
          p.vx *= -1;
        } else if (p.x > w) {
          p.x = w;
          p.vx *= -1;
        }
        if (p.y < 0) {
          p.y = 0;
          p.vy *= -1;
        } else if (p.y > h) {
          p.y = h;
          p.vy *= -1;
        }
      }
    }

    if (now - lastTime >= 500) {
      const fps = Math.round((frames * 1000) / (now - lastTime));
      fpsLabel.setText(`FPS: ${fps}`);
      latencyLabel.setText(`Frame Cost: ${(1000 / fps).toFixed(1)} ms`);
      chart.pushData(fps);

      const mem = (performance as any).memory;
      if (mem) {
        gcText.setText(
          `Memory Footprint: ${(mem.usedJSHeapSize / 1024 / 1024).toFixed(1)} MB (Zero-GC Mode)`,
        );
      } else {
        gcText.setText(`Memory Status: Flat allocations (Zero-GC Mode)`);
      }

      frames = 0;
      lastTime = now;
    }

    currentAnimationFrame = requestAnimationFrame(tickStats);
  };

  currentAnimationFrame = requestAnimationFrame(tickStats);

  // Resize handler
  const resizeHandler = () => {
    controlCard.y = window.innerHeight / 2 - 260;
    statsCard.x = window.innerWidth - 520;
    statsCard.y = window.innerHeight / 2 - 260;
  };
  window.addEventListener('resize', resizeHandler);
  currentResizeHandler = resizeHandler;
}

function setupSelector() {
  const container = document.createElement('div');
  container.className = 'backend-selector';

  const btnCanvas = document.createElement('button');
  btnCanvas.className = 'backend-btn active';
  btnCanvas.innerText = 'Canvas 2D';
  btnCanvas.onclick = () => {
    if (btnCanvas.classList.contains('active')) return;
    document.querySelectorAll('.backend-btn').forEach((btn) => btn.classList.remove('active'));
    btnCanvas.classList.add('active');
    initCanvasDemo();
  };

  const btnThree = document.createElement('button');
  btnThree.className = 'backend-btn';
  btnThree.innerText = 'WebGL (Three.js)';
  btnThree.onclick = () => {
    if (btnThree.classList.contains('active')) return;
    document.querySelectorAll('.backend-btn').forEach((btn) => btn.classList.remove('active'));
    btnThree.classList.add('active');
    initThreeDemo();
  };

  const btnDashboard = document.createElement('button');
  btnDashboard.className = 'backend-btn';
  btnDashboard.innerText = 'Performance Dashboard';
  btnDashboard.onclick = () => {
    if (btnDashboard.classList.contains('active')) return;
    document.querySelectorAll('.backend-btn').forEach((btn) => btn.classList.remove('active'));
    btnDashboard.classList.add('active');
    initDashboardDemo();
  };

  container.appendChild(btnCanvas);
  container.appendChild(btnThree);
  container.appendChild(btnDashboard);
  document.body.appendChild(container);
}

// Start with standard canvas demo
setupSelector();
initCanvasDemo();
