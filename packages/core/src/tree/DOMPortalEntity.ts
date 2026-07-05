import { Entity, VectoEvent, VectoJSEvent } from './Entity';

export class DOMPortalEntity extends Entity {
  public domElement: HTMLElement;
  public override isDOMPortal: boolean = true;
  private domListeners: Array<{ type: string; handler: (e: any) => void; capture: boolean }> = [];

  private resizeObserver: ResizeObserver | null = null;
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

      const events: VectoEvent[] = ['click', 'pointerdown', 'pointerup', 'pointermove', 'wheel'];
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
  }

  isPointInside(globalX: number, globalY: number): boolean {
    const w = this.width > 0 ? this.width : this.cachedWidth;
    const h = this.height > 0 ? this.height : this.cachedHeight;
    const local = this.worldToLocal(globalX, globalY);
    if (!local) return false;
    return local.x >= 0 && local.x <= w && local.y >= 0 && local.y <= h;
  }

  public override add(_child: Entity): this {
    console.warn(`DOMPortalEntity (${this.id}) is a leaf node. Child entities are not supported.`);
    return this;
  }

  render(): void {
    // no-op
  }

  destroy(): void {
    if (typeof window !== 'undefined') {
      if (this.resizeObserver) {
        this.resizeObserver.disconnect();
        this.resizeObserver = null;
      }
      if (this.domElement) {
        for (const { type, handler, capture } of this.domListeners) {
          this.domElement.removeEventListener(type, handler, capture);
        }
        this.domListeners = [];
        this.domElement.remove();
      }
    }
    super.destroy();
  }
}
