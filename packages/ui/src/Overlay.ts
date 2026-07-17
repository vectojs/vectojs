import { Entity, IRenderer, type Scene } from '@vectojs/core';
import { UIComponent } from './UIComponent';

export type OverlayPlacement =
  | 'top'
  | 'top-start'
  | 'top-end'
  | 'bottom'
  | 'bottom-start'
  | 'bottom-end'
  | 'left'
  | 'right'
  | 'auto';

export interface OverlayOptions {
  /** Width of the floating panel. */
  width: number;
  /** Height of the floating panel. */
  height: number;
  /** Preferred placement relative to the target entity. Default `'bottom'`. */
  placement?: OverlayPlacement;
  /** Gap in pixels between the target and the overlay. Default `6`. */
  offset?: number;
}

/**
 * Base class for all floating UI elements (Tooltip, Popover, ContextMenu).
 *
 * Handles:
 * - Computing canvas-space position relative to a target entity
 * - Edge collision detection & placement flip
 * - Mounting to `scene.overlayRoot` (bypasses `clipChildren`, always on top)
 * - Spring-based opacity + scale appear/disappear animation
 *
 * Subclasses implement `render()` to draw their content.
 */
export class Overlay extends UIComponent {
  public placement: OverlayPlacement;
  public offset: number;
  public visible: boolean = false;

  constructor(opts: OverlayOptions) {
    super();
    this.width = opts.width;
    this.height = opts.height;
    this.placement = opts.placement ?? 'bottom';
    this.offset = opts.offset ?? 6;
    this.interactive = false;
    // Seed the hidden state (instant, before any transition is configured), then
    // declare how show/hide animate. Replaces the old hand-rolled *= 0.18 lerp.
    this.opacity = 0;
    this.scaleX = 0.92;
    this.scaleY = 0.92;
    this.setTransition({
      opacity: { duration: 160, easing: 'easeOutQuad' },
      scaleX: 'spring',
      scaleY: 'spring',
    });
  }

  /**
   * Show the overlay anchored to a target entity.
   * Automatically mounts to `scene.overlayRoot` on first call.
   */
  public showAt(target: Entity): void {
    this._mount(target);
    this._position(target);
    this.visible = true;
    this.opacity = 1;
    this.scaleX = 1;
    this.scaleY = 1;
    this.scene?.markDirty();
  }

  /**
   * Show the overlay at an absolute canvas position.
   *
   * If the overlay has never been added to the scene tree (no `parent`), its
   * `scene` resolves to `null` (the `Entity.scene` getter walks the parent
   * chain). To make the documented "bare `new ContextMenu({...})` then
   * `showAtPoint`" pattern work without forcing every caller to pre-mount,
   * pass a `source` — either the `Scene` itself or any mounted `Entity` whose
   * `.scene` is set (e.g. the entity whose `pointerdown` listener is calling
   * you) — and the overlay will auto-mount to that scene's `overlayRoot`.
   * Without a `source` and no resolvable `scene`, this method silently
   * no-ops (preserved for backward compatibility; existing pre-mount-then-
   * showAtPoint callers are unchanged).
   */
  public showAtPoint(x: number, y: number, source?: Entity | Scene): void {
    const scene = (this.scene as Scene | null) ?? this._sceneFromSource(source);
    if (!scene) return;
    if (!this.parent) scene.overlayRoot.add(this);
    this._placeAt(x, y);
    this.visible = true;
    this.opacity = 1;
    this.scaleX = 1;
    this.scaleY = 1;
    scene.markDirty();
  }

  /**
   * Resolve a {@link Scene} from the optional `showAtPoint` `source` arg.
   * Accepts a `Scene` passed directly, or any mounted `Entity` whose `.scene`
   * is the authoritative source (e.g. the entity whose `pointerdown` listener
   * is opening the menu).
   *
   * `protected`, not `private`: subclasses that override `showAtPoint` (e.g.
   * `ContextMenu`, to mount its outside-click backdrop) need this same
   * resolution — duplicating it drifts out of sync with the base
   * implementation, which is exactly how `ContextMenu.showAtPoint` silently
   * dropped the `source` arg it was handed (see its override for the fix).
   */
  protected _sceneFromSource(source?: Entity | Scene): Scene | null {
    if (!source) return null;
    // A `Scene` passed directly — duck-typed via the `markDirty` method it
    // exposes alongside `overlayRoot`, so an `Entity` instance that happens
    // to also have those fields doesn't get misread as a Scene.
    if (
      'overlayRoot' in source &&
      typeof (source as { markDirty?: unknown }).markDirty === 'function'
    ) {
      return source as Scene;
    }
    // Otherwise treat as an Entity whose `.scene` is the authoritative source.
    return ((source as Entity).scene as Scene | null) ?? null;
  }

  /** Animate the overlay out (stays mounted; re-show via showAt). */
  public hide(): void {
    this.visible = false;
    this.opacity = 0;
    this.scaleX = 0.92;
    this.scaleY = 0.92;
    this.scene?.markDirty();
  }

  private _mount(target: Entity): void {
    const scene = target.scene;
    if (!scene) return;
    if (this.parent) this.parent.remove(this);
    scene.overlayRoot.add(this);
  }

  private _position(target: Entity): void {
    const targetBounds = target.getWorldBounds();
    const gp = { x: targetBounds.x, y: targetBounds.y };
    const tw = targetBounds.width;
    const th = targetBounds.height;
    const sw = this.scene?.width ?? window.innerWidth;
    const sh = this.scene?.height ?? window.innerHeight;
    let pl = this.placement;

    if (pl === 'auto') {
      const below = sh - (gp.y + th);
      const above = gp.y;
      pl = below >= this.height + this.offset ? 'bottom' : 'top';
      if (below < this.height + this.offset && above < this.height + this.offset)
        pl = below >= above ? 'bottom' : 'top';
    }

    let ax = gp.x;
    let ay = gp.y;
    switch (pl) {
      case 'top':
        ax = gp.x + tw / 2 - this.width / 2;
        ay = gp.y - this.height - this.offset;
        break;
      case 'top-start':
        ax = gp.x;
        ay = gp.y - this.height - this.offset;
        break;
      case 'top-end':
        ax = gp.x + tw - this.width;
        ay = gp.y - this.height - this.offset;
        break;
      case 'bottom':
        ax = gp.x + tw / 2 - this.width / 2;
        ay = gp.y + th + this.offset;
        break;
      case 'bottom-start':
        ax = gp.x;
        ay = gp.y + th + this.offset;
        break;
      case 'bottom-end':
        ax = gp.x + tw - this.width;
        ay = gp.y + th + this.offset;
        break;
      case 'left':
        ax = gp.x - this.width - this.offset;
        ay = gp.y + th / 2 - this.height / 2;
        break;
      case 'right':
        ax = gp.x + tw + this.offset;
        ay = gp.y + th / 2 - this.height / 2;
        break;
    }
    this._placeAt(ax, ay, sw, sh);
  }

  private _placeAt(ax: number, ay: number, sw?: number, sh?: number): void {
    const W = sw ?? this.scene?.width ?? window.innerWidth;
    const H = sh ?? this.scene?.height ?? window.innerHeight;
    this.x = Math.max(4, Math.min(ax, W - this.width - 4));
    this.y = Math.max(4, Math.min(ay, H - this.height - 4));
  }

  public render(_r: IRenderer): void {
    // Subclasses draw content; base draws nothing.
  }
}
