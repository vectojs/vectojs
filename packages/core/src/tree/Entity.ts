export interface Point {
  x: number;
  y: number;
}

export type VectoEvent =
  | 'click'
  | 'hover'
  | 'pointerdown'
  | 'pointerup'
  | 'pointermove'
  | 'pointerleave';

export abstract class Entity {
  public id: string;
  public children: Entity[] = [];
  public parent: Entity | null = null;

  public x: number = 0;
  public y: number = 0;
  public scaleX: number = 1;
  public scaleY: number = 1;
  public rotation: number = 0;
  public opacity: number = 1;

  protected listeners: Map<VectoEvent, Array<(e: any) => void>> = new Map();
  private animations: Array<any> = [];

  constructor(id?: string) {
    this.id = id || `entity_${Math.random().toString(36).substring(2, 9)}`;
  }

  public add(child: Entity): this {
    child.parent = this;
    this.children.push(child);
    return this;
  }

  public setPosition(x: number, y: number): this {
    this.x = x;
    this.y = y;
    return this;
  }

  // Animation Tweening Engine
  public animate(targetProps: Partial<this>, durationMs: number): this {
    this.animations.push({
      target: targetProps,
      duration: durationMs,
      startTime: -1,
      startProps: {},
    });
    return this;
  }

  public update(dt: number, time: number): void {
    if (this.animations.length > 0) {
      const anim = this.animations[0];
      if (anim.startTime === -1) {
        anim.startTime = time;
        for (const key in anim.target) {
          anim.startProps[key] = (this as any)[key];
        }
      }

      const progress = Math.min((time - anim.startTime) / anim.duration, 1);

      // Interpolate
      for (const key in anim.target) {
        const start = anim.startProps[key];
        const end = anim.target[key];
        if (typeof start === 'number' && typeof end === 'number') {
          // Basic EaseOutQuad interpolation
          const easeOut = progress * (2 - progress);
          (this as any)[key] = start + (end - start) * easeOut;
        }
      }

      if (progress >= 1) {
        this.animations.shift(); // remove finished animation
      }
    }
  }

  public on(event: VectoEvent, callback: (e: any) => void): this {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(callback);
    return this;
  }

  public emit(event: VectoEvent, payload: any): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.forEach((h) => h(payload));
    }
  }

  public getGlobalPosition(): Point {
    let px = this.x;
    let py = this.y;
    let curr = this.parent;
    while (curr && curr.id !== 'root') {
      px += curr.x;
      py += curr.y;
      curr = curr.parent;
    }
    return { x: px, y: py };
  }

  public abstract isPointInside(globalX: number, globalY: number): boolean;
  public abstract render(renderer: any): void;
}
