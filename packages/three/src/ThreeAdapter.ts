import * as THREE from 'three';
import {
  Scene as VectoScene,
  Entity,
  VectoJSEvent,
  SceneOptions,
  VectoEvent,
  KEYBOARD_OWNING_ROLES,
} from '@vectojs/core';

export interface ThreeAdapterOptions {
  /** Physical layout width of the 2D UI canvas. */
  width: number;
  /** Physical layout height of the 2D UI canvas. */
  height: number;
  /** Optional pre-existing canvas element. If omitted, a new canvas is created. */
  canvas?: HTMLCanvasElement;
  /** Options passed to the VectoScene constructor. */
  sceneOptions?: SceneOptions;
}

/** Modifier switches mirroring the `KeyboardEvent` modifier flags. */
export interface ThreeAdapterKeyModifiers {
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  /**
   * Physical key (`KeyboardEvent.code`). Inferred from `key` when omitted:
   * letters map to `` `Key<X>` ``, digits to `` `Digit<N>` ``, `' '` to
   * `'Space'`, and anything else (already code-shaped keys such as
   * `'Enter'`/`'ArrowLeft'`) passes through unchanged. The inference is
   * best-effort by design — `KeyboardEvent.code` is layout-dependent and the
   * adapter does not know the host's layout.
   */
  code?: string;
}

/** Pointer phases {@link ThreeAdapter.dispatchPointer} accepts. */
export type ThreeAdapterPointerType =
  | 'pointerdown'
  | 'pointerup'
  | 'pointercancel'
  | 'pointermove'
  | 'click';

/**
 * Extra `PointerEvent` fields for {@link ThreeAdapter.dispatchPointer}. Every
 * field defaults to the same neutral value the raycaster path produces when no
 * original event is supplied (`button`/`buttons` 0, modifiers off), so a
 * programmatic dispatch is indistinguishable downstream unless the caller
 * populates fields explicitly.
 */
export interface ThreeAdapterPointerInit {
  pointerId?: number;
  button?: number;
  buttons?: number;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

interface PointerState {
  isHovering: boolean;
  lastUv: THREE.Vector2;
  lastTargetId: string | null;
}

/**
 * Shape the SSR fallback canvas is assumed to expose when there is no DOM to
 * create a real `<canvas>` (`document` undefined). Previously this was a bare
 * `{ width, height } as HTMLCanvasElement`, hiding which members consumers may
 * touch; spelling them out keeps the assumption visible and type-checked at
 * the single construction site. Anything beyond these members is unsupported
 * without a real canvas.
 */
interface OffscreenCanvasFallback {
  width: number;
  height: number;
  addEventListener?: HTMLCanvasElement['addEventListener'];
  removeEventListener?: HTMLCanvasElement['removeEventListener'];
  dispatchEvent?: HTMLCanvasElement['dispatchEvent'];
}

/**
 * Adapts a VectoJS Scene into a Three.js CanvasTexture, allowing VectoJS
 * components to be rendered in 3D space (e.g. on a plane, screen, or VR dashboard).
 */
export class ThreeAdapter {
  /** The Three.js CanvasTexture wrapping the offscreen Vecto canvas. */
  public texture: THREE.CanvasTexture;
  /** The active VectoJS Scene instance. */
  public vectoScene: VectoScene;
  /** The offscreen HTMLCanvasElement on which Vecto draws. */
  public canvas: HTMLCanvasElement;
  /** A pre-built THREE.Mesh with PlaneGeometry and this texture for immediate use. */
  public mesh: THREE.Mesh;

  /** Track hover states independently per pointerId for WebXR / Multi-Touch. */
  private activePointers: Map<number, PointerState> = new Map();

  /**
   * The entity currently holding panel focus, or `null`. Panel focus is
   * Three-side state: the adapter canvas is offscreen, so its projected a11y
   * mirrors can never become `document.activeElement` — the adapter tracks the
   * focused entity itself and bridges focus transitions through synthetic
   * `FocusEvent`s so core-side state (entity `focus`/`blur` emits,
   * `focusedA11yElement`, caret-blink wake) matches a connected canvas.
   */
  private _focusedEntity: Entity | null = null;

  /**
   * Holds the original `vectoScene.render` reference so {@link dispose} can
   * restore it. Without restoring, a later render call would write
   * `needsUpdate` on a disposed (deleted) `CanvasTexture`, which Three.js
   * flags with `"THREE.Texture: trying to use deleted texture"`.
   */
  private _originalRender: VectoScene['render'] | null = null;

  /** Tracks whether this adapter owns the canvas it is rendering to. */
  private _ownsCanvas: boolean;
  private _disposed = false;

  constructor(options: ThreeAdapterOptions) {
    const optCanvas = options.canvas;
    this._ownsCanvas = !optCanvas;
    this.canvas =
      optCanvas ||
      (typeof document !== 'undefined'
        ? document.createElement('canvas')
        : ({
            width: options.width,
            height: options.height,
          } satisfies OffscreenCanvasFallback as unknown as HTMLCanvasElement));
    this.canvas.width = options.width;
    this.canvas.height = options.height;

    // Enforce custom resize handling
    const sceneOptions: SceneOptions = {
      ...options.sceneOptions,
      disableWindowResize: true,
    };

    // Initialize Vecto Scene
    this.vectoScene = new VectoScene(this.canvas, sceneOptions);
    this.vectoScene.resize(options.width, options.height);

    // Create CanvasTexture
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;

    // Proxy intercept VectoScene.render to set texture.needsUpdate = true only when redrawing
    this._originalRender = this.vectoScene.render;
    const originalRender = this._originalRender;
    this.vectoScene.render = (renderer, dt, time) => {
      originalRender.call(this.vectoScene, renderer, dt, time);
      this.texture.needsUpdate = true;
    };

    // Construct default mesh (size: 1x1 plane)
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(geometry, material);
  }

  /**
   * Processes 3D Raycasting intersections and forwards pointer/scroll events.
   * Call this from window/document event listeners passing the raycaster.
   *
   * @param raycaster Three.js Raycaster instance.
   * @param type Pointer event type: 'pointerdown' | 'pointerup' | 'pointercancel' | 'pointermove' | 'wheel' | 'click'.
   * @param originalEvent Optional original DOM Event to forward scroll deltas or button states.
   * @returns true if the ray intersected the VectoJS mesh; false otherwise.
   */
  public updateIntersection(
    raycaster: THREE.Raycaster,
    type: 'pointerdown' | 'pointerup' | 'pointercancel' | 'pointermove' | 'wheel' | 'click',
    originalEvent?: Event,
  ): boolean {
    const intersects = raycaster.intersectObject(this.mesh);
    const pointerId = originalEvent instanceof PointerEvent ? originalEvent.pointerId : 1;

    let state = this.activePointers.get(pointerId);
    if (!state) {
      state = { isHovering: false, lastUv: new THREE.Vector2(), lastTargetId: null };
      this.activePointers.set(pointerId, state);
    }

    if (intersects.length > 0) {
      const hit = intersects[0];
      if (hit.uv) {
        state.lastUv.copy(hit.uv);
        state.isHovering = true;
        this.dispatchAtUv(type, hit.uv, pointerId, originalEvent);
        this.pruneEndedPointer(pointerId, type);
        return true;
      }
    }

    // Trigger pointerleave when the cursor exits the UI boundaries
    if (state.isHovering) {
      state.isHovering = false;
      this.dispatchAtUv('pointerleave', state.lastUv, pointerId, originalEvent);
    }
    // Clicking off-panel blurs, mirroring how a click on page background moves
    // DOM focus away from a control. Independent of the leave above: a first
    // click outside also blurs even though nothing was hovered.
    if (type === 'pointerdown' && this._focusedEntity) {
      this.setFocusedEntity(null);
    }
    this.pruneEndedPointer(pointerId, type);
    return false;
  }

  /**
   * Touch contacts receive fresh, monotonically increasing pointerIds, so
   * without pruning {@link activePointers} grew by one entry per tap for the
   * adapter's lifetime (previously only `dispose()` cleared it). pointerup /
   * pointercancel end a contact — its state is dropped once the final event
   * has been dispatched, since dispatchAtUv still reads that state.
   */
  private pruneEndedPointer(
    pointerId: number,
    type: 'pointerdown' | 'pointerup' | 'pointercancel' | 'pointermove' | 'wheel' | 'click',
  ): void {
    if (type === 'pointerup' || type === 'pointercancel') {
      this.activePointers.delete(pointerId);
    }
  }

  /**
   * Dispatches pointer events mapped from UV coordinates [0, 1] to VectoJS entities.
   */
  private dispatchAtUv(
    type: VectoEvent,
    uv: THREE.Vector2,
    pointerId: number,
    originalEvent?: Event,
  ): void {
    // Map UVs into the Scene's LOGICAL coordinate space, never the canvas's
    // physical backing-store size: on HiDPI displays the CanvasRenderer scales
    // the backing store (canvas.width = logicalWidth * devicePixelRatio) while
    // entity layout and findEntityAt stay logical, so multiplying by
    // canvas.width would land every hit down/right by exactly the DPR factor.
    const px = uv.x * this.vectoScene.width;
    // Map Three.js Y (0 is bottom) to Canvas Y (0 is top)
    const py = (1.0 - uv.y) * this.vectoScene.height;
    this.dispatchAtPoint(type, px, py, pointerId, originalEvent);
  }

  /**
   * Shared dispatch core for both entry paths: {@link updateIntersection}
   * (raycast UV mapped to logical pixels) and {@link dispatchPointer}
   * (logical pixels directly). Returns whether an entity was hit.
   */
  private dispatchAtPoint(
    type: VectoEvent,
    px: number,
    py: number,
    pointerId: number,
    originalEvent?: Event,
  ): boolean {
    // Trigger markDirty so the scene repaints immediately in onDemand mode
    this.vectoScene.markDirty();

    // Perform Vecto hierarchy hit testing
    const hitEntity = this.vectoScene.findEntityAt(px, py);
    const state = this.activePointers.get(pointerId);

    // Handle element hover transition events
    if (state && type === 'pointermove') {
      const currentTargetId = hitEntity ? hitEntity.id : null;
      if (currentTargetId !== state.lastTargetId) {
        if (state.lastTargetId) {
          const oldEntity = this.findEntityById(this.vectoScene.getRoot(), state.lastTargetId);
          if (oldEntity) {
            this.dispatchEventToTarget(oldEntity, 'pointerleave', px, py, pointerId, originalEvent);
          }
        }
        if (hitEntity) {
          this.dispatchEventToTarget(hitEntity, 'hover', px, py, pointerId, originalEvent);
        }
        state.lastTargetId = currentTargetId;
      }
    } else if (state && type === 'pointerleave') {
      if (state.lastTargetId) {
        const oldEntity = this.findEntityById(this.vectoScene.getRoot(), state.lastTargetId);
        if (oldEntity) {
          this.dispatchEventToTarget(oldEntity, 'pointerleave', px, py, pointerId, originalEvent);
        }
      }
      state.lastTargetId = null;
      // Skip the trailing dispatch: lastUv still points inside the mesh, so
      // findEntityAt below returns the (or a) hovered entity, which already
      // received its pointerleave above — delivering again duplicates the
      // event, and the canvas fallback would leak a leave the host never
      // initiated.
      return false;
    }

    if (hitEntity) {
      this.dispatchEventToTarget(hitEntity, type, px, py, pointerId, originalEvent);
    } else {
      // Fallback: dispatch to canvas itself
      const fallbackEvent = this.createDOMEvent(type, px, py, pointerId, originalEvent);
      this.canvas.dispatchEvent(fallbackEvent);
    }

    // Pointer interaction drives panel focus, mirroring how clicking a control
    // moves DOM focus on a connected canvas. The hit entity is focused when it
    // (or an ancestor) projects keyboard reachability; clicking dead space
    // blurs. Runs AFTER the event so handlers observe the pre-click focus
    // world, matching native pointerdown-then-focus ordering.
    if (type === 'pointerdown') {
      if (hitEntity) this.focusNearestFocusable(hitEntity);
      else this.setFocusedEntity(null);
    }
    return hitEntity !== null;
  }

  /**
   * Routes events to the associated A11y DOM element, or Vecto's own event dispatch system.
   */
  private dispatchEventToTarget(
    entity: Entity,
    type: VectoEvent,
    x: number,
    y: number,
    pointerId: number,
    originalEvent?: Event,
  ): void {
    const a11yEl = this.vectoScene.getA11yElement(entity.id);

    // If an associated transparent DOM element exists AND is connected to a live
    // document, dispatch to it to drive natively-bound widgets. ThreeAdapter's
    // canvas is always offscreen (rendered into a texture, never inserted into
    // the page), so the Scene's a11yRoot is never attached to `document` either —
    // getA11yElement() can still return a real element (syncA11y populates it
    // regardless), but it's permanently disconnected. Native DOM APIs some
    // components' internals rely on (setPointerCapture, robust focus()) require a
    // connected element and throw otherwise, so route disconnected elements
    // through the same fallback used when no a11y element exists at all.
    if (a11yEl && a11yEl.isConnected) {
      const domEvent = this.createDOMEvent(type, x, y, pointerId, originalEvent);
      a11yEl.dispatchEvent(domEvent);

      // Handle focus activation for inputs/textareas
      if (
        type === 'pointerdown' &&
        (a11yEl instanceof HTMLInputElement ||
          a11yEl instanceof HTMLTextAreaElement ||
          a11yEl.getAttribute('tabindex') !== null)
      ) {
        a11yEl.focus();
      }
    } else {
      // Fallback: bubble the VectoJSEvent up the virtual tree directly
      const vectoEvent = new VectoJSEvent(type, entity, originalEvent, type !== 'pointerleave', {
        x,
        y,
      });
      entity.dispatchEvent(vectoEvent);
    }
  }

  private createDOMEvent(
    type: VectoEvent,
    x: number,
    y: number,
    pointerId: number,
    originalEvent?: Event,
  ): Event {
    let event: Event;
    if (type === 'wheel') {
      const wheelE = originalEvent instanceof WheelEvent ? originalEvent : undefined;
      event = new WheelEvent('wheel', {
        clientX: x,
        clientY: y,
        deltaX: wheelE ? wheelE.deltaX : 0,
        deltaY: wheelE ? wheelE.deltaY : 0,
        deltaZ: wheelE ? wheelE.deltaZ : 0,
        deltaMode: wheelE ? wheelE.deltaMode : 0,
        shiftKey: wheelE ? wheelE.shiftKey : false,
        ctrlKey: wheelE ? wheelE.ctrlKey : false,
        altKey: wheelE ? wheelE.altKey : false,
        metaKey: wheelE ? wheelE.metaKey : false,
        bubbles: true,
        cancelable: true,
      });
    } else {
      event = new PointerEvent(type as string, {
        clientX: x,
        clientY: y,
        button: originalEvent instanceof MouseEvent ? originalEvent.button : 0,
        buttons: originalEvent instanceof MouseEvent ? originalEvent.buttons : 0,
        pointerId,
        shiftKey: originalEvent instanceof MouseEvent ? originalEvent.shiftKey : false,
        ctrlKey: originalEvent instanceof MouseEvent ? originalEvent.ctrlKey : false,
        altKey: originalEvent instanceof MouseEvent ? originalEvent.altKey : false,
        metaKey: originalEvent instanceof MouseEvent ? originalEvent.metaKey : false,
        bubbles: true,
        cancelable: true,
      });
    }

    Object.defineProperties(event, {
      vectoSceneX: { value: x },
      vectoSceneY: { value: y },
    });
    return event;
  }

  private findEntityById(root: Entity, id: string): Entity | null {
    if (root.id === id) return root;
    for (const child of root.children) {
      const found = this.findEntityById(child, id);
      if (found) return found;
    }
    return null;
  }

  // --- domain: input — panel focus management ---

  /**
   * The entity currently holding panel focus, or `null`.
   *
   * Panel focus is Three-side state (see {@link _focusedEntity}): the adapter
   * canvas is offscreen, so its projected a11y mirrors can never become
   * `document.activeElement` and the browser's focus model does not reach
   * them. The adapter fills that gap — pointer interaction and
   * {@link ThreeAdapter.focus} drive it, key routing consumes it, and every
   * transition is bridged through synthetic `FocusEvent`s so core-side state
   * matches a connected canvas.
   */
  public get focusedEntity(): Entity | null {
    return this._disposed ? null : this._focusedEntity;
  }

  /**
   * Move panel focus to `entity`, or blur with `null`.
   *
   * Unlike the pointer path (which focuses only what the projection declares
   * reachable), this accepts any entity so tests and automation can force
   * focus onto a specific node. Focus transitions are bridged through the
   * projection when a mirror exists, so entities receive `focus`/`blur`
   * emits, core tracks `focusedA11yElement`, and text fields wake their caret
   * blink exactly as they do on a connected canvas. No-op when the state
   * already matches.
   *
   * @param entity - The entity to focus, or `null` to blur.
   */
  public focus(entity: Entity | null): void {
    if (this._disposed || entity === this._focusedEntity) return;
    this.setFocusedEntity(entity);
  }

  /** Blur the currently focused panel entity, if any. See {@link ThreeAdapter.focus}. */
  public blur(): void {
    this.focus(null);
  }

  /**
   * Whether `entity` projects as keyboard-reachable — the panel-side analog of
   * DOM tabbability. True when the projected mirror carries a `tabindex`
   * attribute (explicit `tabIndex`, or the implicit `0` core adds for
   * interactive ARIA roles) or renders as a natively-focusable tag
   * (`button`/`input`/`textarea`/`select`/`a[href]`). Falls back to the raw
   * {@link Entity.getA11yAttributes} values before the first projection sync.
   *
   * @param entity - The entity to query.
   */
  public isFocusable(entity: Entity): boolean {
    if (this._disposed || !entity.getA11yAttributes) return false;
    const attrs = entity.getA11yAttributes();
    const el = this.vectoScene.getA11yElement(entity.id);
    const tag = (el ? el.tagName.toLowerCase() : (attrs.tag ?? 'div')).toLowerCase();
    const href = el?.getAttribute('href') ?? attrs.href;
    const nativelyFocusable =
      tag === 'button' ||
      tag === 'input' ||
      tag === 'textarea' ||
      tag === 'select' ||
      (tag === 'a' && !!href);
    if (nativelyFocusable) return true;
    return el ? el.hasAttribute('tabindex') : attrs.tabIndex !== undefined;
  }

  /**
   * Focus the nearest focusable ancestor of `hit` (including itself), or blur
   * when the hit chain projects nothing reachable — the analog of clicking a
   * `<span>` inside a `<button>`, which focuses the button.
   */
  private focusNearestFocusable(hit: Entity): void {
    for (let node: Entity | null = hit; node; node = node.parent) {
      if (this.isFocusable(node)) {
        this.setFocusedEntity(node);
        return;
      }
    }
    this.setFocusedEntity(null);
  }

  /**
   * Apply a focus transition through the projection: synthetic `focus`/
   * `blur` `FocusEvent`s on the mirrors let core's own listeners run (entity
   * emits, `focusedA11yElement` tracking, caret-blink wake/cleanup); entities
   * without a mirror get direct `emit`s. Always schedules a repaint so focus
   * visuals (caret, highlight) draw immediately in onDemand mode.
   */
  private setFocusedEntity(next: Entity | null): void {
    const prev = this._focusedEntity;
    this._focusedEntity = next;
    if (prev) {
      const prevEl = this.vectoScene.getA11yElement(prev.id);
      if (prevEl) prevEl.dispatchEvent(new FocusEvent('blur'));
      else prev.emit('blur', {});
    }
    if (next) {
      const nextEl = this.vectoScene.getA11yElement(next.id);
      if (nextEl) nextEl.dispatchEvent(new FocusEvent('focus'));
      else next.emit('focus', {});
    }
    this.vectoScene.markDirty();
  }

  // --- domain: input — keyboard routing ---

  /**
   * Synthesize keyboard input and route it through the adapter's dispatch
   * path — the keyboard counterpart of {@link updateIntersection}.
   *
   * Routing rules, mirroring how keys behave on a connected canvas:
   *
   * 1. **Panel focus** — when an entity holds panel focus (via
   *    {@link updateIntersection} pointer interaction or {@link ThreeAdapter.focus}),
   *    the synthesized event is dispatched at that entity's projected mirror,
   *    so core's own listeners run unchanged: entity `keydown`/`keyup`
   *    handlers receive it, and projected controls keep their activation
   *    contract (`Enter` activates on press, `Space` on release).
   * 2. **Ownership** — while the focused entity projects a keyboard-owning
   *    role, the panel owns the keys exclusively and nothing leaks to the
   *    page: `input`, `textarea`, `select` tags, and anything whose role is in
   *    core's {@link KEYBOARD_OWNING_ROLES} (`textbox`, `searchbox`,
   *    `spinbutton`, `option`, `listbox`, plus the interactive roles
   *    `button`, `link`, `tab`, `menuitem`, `slider`, `combobox`). This is the
   *    same set `ownsKeyboard` gates the scene channel by — here applied to
   *    panel-side state because a disconnected mirror can never become
   *    `document.activeElement`.
   * 3. **Channel forwarding** — otherwise the event continues to
   *    `window`, where the #636 scene-level channel applies its native gates
   *    (`defaultPrevented`, auto-repeat, `ownsKeyboard(document.activeElement)`):
   *    scene shortcuts and page-level consumers see it unless a page-level
   *    keyboard owner holds focus, so orbit-camera consumers and host inputs
   *    are never starved. An entity handler that calls
   *    `nativeEvent.preventDefault()` (or stops propagation on the synthetic
   *    event) suppresses the forward, matching connected-canvas bubbling.
   * 4. **No panel focus** — the event goes straight to `window` and the same
   *    gates decide.
   *
   * @param key - `KeyboardEvent.key` value (`'a'`, `'Enter'`, `'ArrowLeft'`, …).
   * @param mods - Optional modifier switches and physical `code`; see
   *   {@link ThreeAdapterKeyModifiers}.
   * @param phase - `'press'` (default) synthesizes the full keydown+keyup
   *   pair; `'keydown'`/`'keyup'` synthesize a single phase for automation
   *   that models held keys explicitly.
   */
  public dispatchKey(
    key: string,
    mods: ThreeAdapterKeyModifiers = {},
    phase: 'press' | 'keydown' | 'keyup' = 'press',
  ): void {
    if (this._disposed || !key) return;
    const init: KeyboardEventInit = {
      key,
      code: mods.code ?? ThreeAdapter.codeFor(key),
      ctrlKey: mods.ctrlKey ?? false,
      altKey: mods.altKey ?? false,
      shiftKey: mods.shiftKey ?? false,
      metaKey: mods.metaKey ?? false,
      bubbles: true,
      cancelable: true,
    };
    if (phase !== 'keyup') this.routeKeyEvent(new KeyboardEvent('keydown', init));
    if (phase !== 'keydown') this.routeKeyEvent(new KeyboardEvent('keyup', init));
  }

  /**
   * Best-effort `KeyboardEvent.code` inference for synthesized events; see
   * {@link ThreeAdapterKeyModifiers.code} to override.
   */
  private static codeFor(key: string): string {
    if (key === ' ') return 'Space';
    if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
    if (/^[0-9]$/.test(key)) return `Digit${key}`;
    return key;
  }

  /**
   * Deliver one synthesized keyboard event along the panel dispatch path:
   * focused mirror first (core's projection listeners run), then the window
   * hop into the #636 scene channel unless ownership or prevention says
   * otherwise. See {@link ThreeAdapter.dispatchKey} for the full contract.
   */
  private routeKeyEvent(native: KeyboardEvent): void {
    if (this._disposed) return;
    this.vectoScene.markDirty();
    const focused = this._focusedEntity;
    if (!focused) {
      // No panel owner: the scene-level channel applies all of its own gates
      // (defaultPrevented / repeat / ownsKeyboard(activeElement)).
      if (typeof window !== 'undefined') window.dispatchEvent(native);
      return;
    }
    const mirror = this.vectoScene.getA11yElement(focused.id);
    if (mirror) {
      // Drive the SAME listeners a connected canvas would: generic key
      // forwarding, #694 Enter/Space activation, everything core attaches.
      mirror.dispatchEvent(native);
    } else {
      focused.dispatchEvent(new VectoJSEvent(native.type as VectoEvent, focused, native));
    }
    if (this.entityOwnsKeyboard(focused)) return;
    // Mirror connected-canvas bubbling: a prevented default keeps the scene
    // channel silent (its first gate), as does a handler that stopped
    // propagation on the synthetic event itself.
    if (native.defaultPrevented) return;
    if ((native as { cancelBubble?: boolean }).cancelBubble) return;
    if (typeof window !== 'undefined') window.dispatchEvent(native);
  }

  /**
   * Whether `entity`'s projection makes it a keyboard owner whose keys must
   * not leak past the panel. Tag-based owners match `ownsKeyboard`'s
   * INPUT/TEXTAREA/SELECT clause; role-based owners use core's exported
   * {@link KEYBOARD_OWNING_ROLES} so the two definitions cannot drift.
   */
  private entityOwnsKeyboard(entity: Entity): boolean {
    const attrs = entity.getA11yAttributes();
    const el = this.vectoScene.getA11yElement(entity.id);
    const tag = (el ? el.tagName.toLowerCase() : (attrs.tag ?? '')).toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    const role = attrs.role;
    return role !== undefined && KEYBOARD_OWNING_ROLES.has(role);
  }

  // --- domain: input — programmatic driving ---

  /**
   * Synthesize pointer input at LOGICAL SCENE coordinates (the space entity
   * layout and `findEntityAt` speak — the same values `clientX`/`clientY`
   * carry on dispatched events). The event flows through the identical
   * downstream path as a raycast-driven {@link updateIntersection}: hover
   * transitions, entity dispatch (or canvas fallback), pointerdown-driven
   * focus, and texture-dirty scheduling all behave the same, which makes this
   * the entry point for tests and automation that have no raycaster.
   *
   * Wheel input is deliberately not covered — wheel deltas have no neutral
   * defaults, so route those through {@link updateIntersection} with the real
   * `WheelEvent`.
   *
   * @param type - Pointer phase to synthesize.
   * @param x - Logical scene-space X (pixels, origin top-left).
   * @param y - Logical scene-space Y (pixels, origin top-left).
   * @param init - Optional pointerId/button/modifier overrides; see
   *   {@link ThreeAdapterPointerInit}.
   * @returns Whether the point hit an entity (mirrors the `updateIntersection`
   *   hit contract).
   */
  public dispatchPointer(
    type: ThreeAdapterPointerType,
    x: number,
    y: number,
    init: ThreeAdapterPointerInit = {},
  ): boolean {
    if (this._disposed) return false;
    const pointerId = init.pointerId ?? 1;
    if (!this.activePointers.has(pointerId)) {
      this.activePointers.set(pointerId, {
        isHovering: false,
        lastUv: new THREE.Vector2(),
        lastTargetId: null,
      });
    }
    const originalEvent = new PointerEvent(type, {
      pointerId,
      clientX: x,
      clientY: y,
      button: init.button ?? 0,
      buttons: init.buttons ?? 0,
      ctrlKey: init.ctrlKey ?? false,
      altKey: init.altKey ?? false,
      shiftKey: init.shiftKey ?? false,
      metaKey: init.metaKey ?? false,
      bubbles: true,
      cancelable: true,
    });
    const hit = this.dispatchAtPoint(type, x, y, pointerId, originalEvent);
    if (type === 'pointerup' || type === 'pointercancel') {
      this.activePointers.delete(pointerId);
    }
    return hit;
  }

  /**
   * Resizes the offscreen canvas and VectoScene dimensions.
   */
  public resize(width: number, height: number): void {
    this.canvas.width = width;
    this.canvas.height = height;
    this.vectoScene.resize(width, height);
    this.texture.needsUpdate = true;
  }

  /**
   * Disposes of Three.js textures, geometries, and VectoJS scenes to prevent memory leaks.
   */
  public dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    // Restore before destroying the Scene so no surviving reference retains a
    // closure over the texture owned by this adapter.
    if (this._originalRender) {
      this.vectoScene.render = this._originalRender;
      this._originalRender = null;
    }
    this.texture.dispose();
    this.mesh.geometry.dispose();
    if (Array.isArray(this.mesh.material)) {
      for (const mat of this.mesh.material) mat.dispose();
    } else {
      this.mesh.material.dispose();
    }
    if (this.mesh.parent) {
      this.mesh.parent.remove(this.mesh);
    }
    this.vectoScene.destroy();
    this.activePointers.clear();
    // Focus died with the scene; drop the reference without emitting — the
    // mirrors and listeners this bridge talks to no longer exist.
    this._focusedEntity = null;
    // Only mutate the canvas dimensions when we created it; otherwise the user
    // may still be using the canvas they passed in.
    if (this._ownsCanvas) {
      this.canvas.width = 0;
      this.canvas.height = 0;
    }
  }
}
