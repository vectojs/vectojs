import { Entity } from './Entity';
import { CanvasRenderer } from '../renderer/CanvasRenderer';
import { IRenderer } from '../renderer/IRenderer';

export class Scene {
  private root: Entity;
  private renderer: CanvasRenderer;
  private isRunning: boolean = false;
  private lastTime: number = 0;
  public canvas: HTMLCanvasElement;

  private pointerX: number = -1000;
  private pointerY: number = -1000;
  private hoveredEntity: Entity | null = null;

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
    this.setupEvents(canvas);
  }

  public getRenderer(): IRenderer {
    return this.renderer;
  }

  public add(entity: Entity): this {
    this.root.add(entity);
    return this;
  }

  private setupEvents(canvas: HTMLCanvasElement): void {
    window.addEventListener('resize', () => {
      this.renderer.resize(window.innerWidth, window.innerHeight);
    });

    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      this.pointerX = e.clientX - rect.left;
      this.pointerY = e.clientY - rect.top;
      this.processPointerMove();
    });

    canvas.addEventListener('click', (e) => {
      if (this.hoveredEntity) {
        this.hoveredEntity.emit('click', { x: this.pointerX, y: this.pointerY });
      }
    });
  }

  private processPointerMove(): void {
    const hit = this.hitTest(this.root, this.pointerX, this.pointerY);

    if (hit !== this.hoveredEntity) {
      if (this.hoveredEntity) {
        this.hoveredEntity.emit('pointerleave', null);
      }
      this.hoveredEntity = hit;
      if (this.hoveredEntity) {
        this.hoveredEntity.emit('hover', null);
      }
    }

    if (this.hoveredEntity) {
      this.hoveredEntity.emit('pointermove', { x: this.pointerX, y: this.pointerY });
    }
  }

  private hitTest(entity: Entity, px: number, py: number): Entity | null {
    for (let i = entity.children.length - 1; i >= 0; i--) {
      const child = entity.children[i];
      const hit = this.hitTest(child, px, py);
      if (hit) return hit;
    }
    if (entity.isPointInside(px, py)) {
      return entity;
    }
    return null;
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

  private loop(time: number): void {
    if (!this.isRunning) return;

    const dt = time - this.lastTime;
    this.lastTime = time;

    this.renderer.clear();

    const renderNode = (node: Entity) => {
      node.update(dt, time); // Tick animations

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

    requestAnimationFrame((t) => this.loop(t));
  }
}
