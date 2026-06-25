import { Entity } from './Entity';
import { CanvasRenderer } from '../renderer/CanvasRenderer';
import { IRenderer } from '../renderer/IRenderer';

export class Scene {
  private root: Entity;
  private renderer: CanvasRenderer;
  private isRunning: boolean = false;
  private lastTime: number = 0;
  public canvas: HTMLCanvasElement;

  // A11y / Automation Layer
  private a11yRoot: HTMLDivElement;
  private a11yElements: Map<string, HTMLElement> = new Map();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.root = new (class RootEntity extends Entity {
      isPointInside() {
        return false;
      }
      render(r: any) {
        for (const child of this.children) {
          child.render(r);
        }
      }
    })('root');

    this.renderer = new CanvasRenderer(canvas);

    // Setup Agent / Automation Semantic Layer
    this.a11yRoot = document.createElement('div');
    this.a11yRoot.style.position = 'absolute';
    this.a11yRoot.style.top = '0';
    this.a11yRoot.style.left = '0';
    this.a11yRoot.style.width = '100vw';
    this.a11yRoot.style.height = '100vh';
    this.a11yRoot.style.pointerEvents = 'none';
    this.a11yRoot.style.overflow = 'hidden';
    this.a11yRoot.style.zIndex = '10'; // Render above canvas
    if (canvas.parentElement) {
      canvas.parentElement.appendChild(this.a11yRoot);
    }

    this.setupEvents();
  }

  public getRenderer(): IRenderer {
    return this.renderer;
  }

  public add(entity: Entity): this {
    this.root.add(entity);
    return this;
  }

  private setupEvents(): void {
    window.addEventListener('resize', () => {
      this.renderer.resize(window.innerWidth, window.innerHeight);
    });
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastTime = performance.now();
    requestAnimationFrame((t) => this.loop(t));
  }

  public stop(): void {
    this.isRunning = false;
  }

  private syncA11y(node: Entity) {
    if (node.interactive && node.width > 0) {
      let el = this.a11yElements.get(node.id);
      if (!el) {
        el = document.createElement('div');
        el.setAttribute('data-vecto-id', node.id);
        el.style.position = 'absolute';
        el.style.pointerEvents = 'auto'; // allow Playwright/Agent to click!
        el.style.cursor = 'pointer';
        // Debug visibility: semi-transparent blue dashed border
        el.style.backgroundColor = 'rgba(56, 189, 248, 0.05)';
        el.style.border = '1px dashed rgba(56, 189, 248, 0.4)';

        // Map DOM events to Canvas ECS Engine
        el.addEventListener('click', (e) => node.emit('click', e));
        el.addEventListener('mouseenter', (e) => {
          el!.style.backgroundColor = 'rgba(56, 189, 248, 0.2)';
          node.emit('hover', e);
        });
        el.addEventListener('mouseleave', (e) => {
          el!.style.backgroundColor = 'rgba(56, 189, 248, 0.05)';
          node.emit('pointerleave', e);
        });

        this.a11yRoot.appendChild(el);
        this.a11yElements.set(node.id, el);
      }

      const pos = node.getGlobalPosition();
      el.style.left = `${pos.x + node.a11yOffsetX}px`;
      el.style.top = `${pos.y + node.a11yOffsetY}px`;
      el.style.width = `${node.width * node.scaleX}px`;
      el.style.height = `${node.height * node.scaleY}px`;
      el.style.transform = `rotate(${node.rotation}rad)`;
    }

    for (const child of node.children) this.syncA11y(child);
  }

  private loop(time: number): void {
    if (!this.isRunning) return;

    const dt = time - this.lastTime;
    this.lastTime = time;

    this.renderer.clear();

    const renderNode = (node: Entity) => {
      node.update(dt, time);

      this.renderer.save();
      this.renderer.translate(node.x, node.y);
      this.renderer.scale(node.scaleX, node.scaleY);
      this.renderer.rotate(node.rotation);
      this.renderer.setGlobalAlpha(node.opacity);

      node.render(this.renderer);

      for (const child of node.children) {
        renderNode(child);
      }
      this.renderer.restore();
    };

    renderNode(this.root);

    // Sync Automation Shadow DOM
    this.syncA11y(this.root);

    requestAnimationFrame((t) => this.loop(t));
  }
}
