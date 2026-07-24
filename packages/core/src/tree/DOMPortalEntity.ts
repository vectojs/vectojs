import { Entity, VectoEvent, VectoJSEvent } from './Entity';

export class DOMPortalEntity extends Entity {
  public domElement: HTMLElement;
  public override isDOMPortal: boolean = true;
  private domListeners: Array<{
    type: string;
    handler: (e: any) => void;
    capture: boolean;
  }> = [];

  private resizeObserver: ResizeObserver | null = null;
  private domBound: boolean = false;
  public cachedWidth: number = 100;
  public cachedHeight: number = 100;

  public lastWidth: string = '';
  public lastHeight: string = '';
  public lastTransform: string = '';
  public lastZIndex: string = '';
  public lastOpacity: string = '';

  constructor(domElement: HTMLElement, width?: number, height?: number, id?: string) {
    super(id);
    this.domElement = domElement;

    this.width = width ?? 0;
    this.height = height ?? 0;

    if (typeof window !== 'undefined') {
      this.domElement.style.position = 'absolute';
      this.domElement.style.transformOrigin = '0 0';
      this.domElement.style.pointerEvents = 'auto';

      this.cachedWidth = parseFloat(domElement.style.width) || domElement.offsetWidth || 100;
      this.cachedHeight = parseFloat(domElement.style.height) || domElement.offsetHeight || 100;

      this.attachDOMBindings();
    }
  }

  /**
   * Attach the ResizeObserver + DOM event listeners that bridge native DOM
   * events into the Vecto event system. Idempotent: safe to call every frame
   * from the projection path (`Scene.syncPortalGeometry`), which is what lets a
   * portal survive a `scene.remove()` -> re-add cycle — {@link releaseDOMBindings}
   * tears these down on removal and the next projection re-attaches them.
   */
  public attachDOMBindings(): void {
    if (this.domBound || typeof window === 'undefined') return;
    this.domBound = true;

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          this.cachedWidth = entry.contentRect.width || (entry.target as HTMLElement).offsetWidth;
          this.cachedHeight =
            entry.contentRect.height || (entry.target as HTMLElement).offsetHeight;
        }
      });
      this.resizeObserver.observe(this.domElement);
    }

    const events: VectoEvent[] = [
      'click',
      'pointerdown',
      'pointerup',
      'pointercancel',
      'pointermove',
      'wheel',
    ];
    for (const type of events) {
      const handler = (e: any) => {
        this.dispatchEvent(new VectoJSEvent(type, this, e));
      };
      this.domElement.addEventListener(type, handler);
      this.domListeners.push({ type, handler, capture: false });
    }

    const hoverEvents: Array<{ native: string; vecto: VectoEvent }> = [
      { native: 'mouseenter', vecto: 'hover' },
      { native: 'mouseleave', vecto: 'pointerleave' },
    ];
    for (const { native, vecto } of hoverEvents) {
      const handler = (e: any) => {
        this.dispatchEvent(new VectoJSEvent(vecto, this, e, false));
      };
      this.domElement.addEventListener(native, handler);
      this.domListeners.push({ type: native, handler, capture: false });
    }

    const focusEvents: string[] = ['focus', 'blur'];
    for (const type of focusEvents) {
      const handler = (e: any) => {
        this.dispatchEvent(new VectoJSEvent(type as VectoEvent, this, e, true));
      };
      this.domElement.addEventListener(type, handler, true);
      this.domListeners.push({ type, handler, capture: true });
    }
  }

  /**
   * Disconnect the ResizeObserver and remove the DOM event listeners, without
   * touching the scene graph or the element's DOM parentage. Called on the
   * `scene.remove()` path so a detached portal doesn't leak an observer that
   * keeps its element alive and firing; the element itself is removed from the
   * document by the scene's portal pruning. Re-attached lazily on the next
   * projection frame via {@link attachDOMBindings}.
   */
  public releaseDOMBindings(): void {
    if (!this.domBound) return;
    this.domBound = false;
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.domElement) {
      for (const { type, handler, capture } of this.domListeners) {
        this.domElement.removeEventListener(type, handler, capture);
      }
    }
    this.domListeners = [];
  }

  isPointInside(globalX: number, globalY: number): boolean {
    const w = this.width > 0 ? this.width : this.cachedWidth;
    const h = this.height > 0 ? this.height : this.cachedHeight;
    const local = this.worldToLocal(globalX, globalY);
    if (!local) return false;
    return local.x >= 0 && local.x <= w && local.y >= 0 && local.y <= h;
  }

  public override add(..._children: Entity[]): this {
    console.warn(`DOMPortalEntity (${this.id}) is a leaf node. Child entities are not supported.`);
    return this;
  }

  render(): void {
    // no-op
  }

  destroy(): void {
    this.releaseDOMBindings();
    if (typeof window !== 'undefined' && this.domElement) {
      this.domElement.remove();
    }
    super.destroy();
  }
}
