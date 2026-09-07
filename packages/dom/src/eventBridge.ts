import { VectoJSEvent, type Entity, type VectoEvent } from '@vectojs/core';

/**
 * Interaction policy for projected elements (RFC §6 layer 2).
 *
 * - `'selection'`: content-interaction mode. Presses mean "select text / press
 *   button / type" and never reach the scene's camera/gesture handlers (the
 *   demo's Selection mode: left goes to content).
 * - `'orbit'`: scene-gesture mode. Presses pass through to camera handlers
 *   (the demo's Orbit mode: left rotates).
 */
export type DOMInteractionMode = 'selection' | 'orbit';

/** Options for {@link attachDOMBridge}. */
export interface DOMBridgeOptions {
  /**
   * Native `input`/`change` (and IME composition) on the element forward as
   * `VectoJSEvent('change')`, mirroring the a11y input-mirror contract whose
   * payload is `{ value, ... }`. Set for editable kinds only.
   */
  editable?: boolean;
  /**
   * Called with the element's current value on every native `input` event
   * (before the `'change'` dispatch), so the node can sync without the bridge
   * knowing the node's shape.
   */
  onNativeInput?: (value: string) => void;
  /** Starting interaction mode (default `'selection'`). */
  mode?: DOMInteractionMode;
  /**
   * Called when a press elects this node as the gesture owner for a
   * `pointerId` (RFC4 §5 never-flip-inside-gesture: the scene pins the node's
   * backend until the matching end). Paired with {@link onGestureEnd}.
   */
  onGestureStart?: (nodeId: string, pointerId: number) => void;
  /**
   * Called when the owning gesture releases (`pointerup`/`pointercancel`),
   * unpinning what {@link onGestureStart} pinned. A release can arrive
   * without a start on this element (press began outside, released inside),
   * so the consumer must tolerate an unmatched end.
   */
  onGestureEnd?: (nodeId: string, pointerId: number) => void;
}

/** Handle returned by {@link attachDOMBridge}. */
export interface DOMBridgeHandle {
  /** Switch the §6 layer-2 policy at runtime. */
  setInteractionMode(mode: DOMInteractionMode): void;
  /** Current policy. */
  getInteractionMode(): DOMInteractionMode;
  /** Remove every listener this bridge installed. Idempotent. */
  release(): void;
}

/**
 * Engine-level gesture election record (input-dispatch-contract v2 §4:
 * gesture stickiness per `pointerId`, single-delivery invariant).
 *
 * P1 is single-source — no mirror exists for a DOM-resident node, so delivery
 * is single by construction — but the election is still recorded here so the
 * arbitration gate RFC4 will build has a source of truth to consult, and so
 * tests can pin that a gesture elects exactly one owner until
 * `pointerup`/`pointercancel`.
 */
const gestureOwner = new Map<number, string>();

/** Test/contract introspection: who owns `pointerId`, if anyone. */
export function getGestureOwner(pointerId: number): string | undefined {
  return gestureOwner.get(pointerId);
}

/**
 * Listener inventory forwarded into the Vecto event system. Mirrors
 * `DOMPortalEntity.attachDOMBindings` (`packages/core/src/tree/DOMPortalEntity.ts:64-100`):
 * unification would mean core importing the bridge from `@vectojs/dom` (a
 * dependency-cycle) or the bridge reaching into portal internals, so the list
 * is mirrored by value with source attribution added. Every dispatch tags
 * `source: 'dom'` — the DOM-visual element counts as a materialized target at
 * its point (input-dispatch v2 §4 rule 4), so handlers see one attributed
 * stream regardless of backend.
 */
const POINTER_EVENTS: VectoEvent[] = [
  'click',
  'pointerup',
  'pointercancel',
  'pointermove',
  'wheel',
];

/** Presses that mean content interaction in `'selection'` mode (RFC §6 layer 1). */
const PRESS_EVENTS = ['pointerdown', 'mousedown', 'touchstart'];

/**
 * Bridge native DOM events on a projected element into the Vecto event system.
 * Idempotent release; safe to re-attach after an unmount cycle.
 */
export function attachDOMBridge(
  el: HTMLElement,
  node: Entity,
  options: DOMBridgeOptions = {},
): DOMBridgeHandle {
  const listeners: Array<{ type: string; handler: (e: Event) => void; capture: boolean }> = [];
  let mode: DOMInteractionMode = options.mode ?? 'selection';
  const on = (type: string, handler: (e: Event) => void, capture = false): void => {
    el.addEventListener(type, handler as EventListener, capture);
    listeners.push({ type, handler, capture });
  };

  // Layer 1 stop rule (RFC §6): in content-interaction mode a capture-phase
  // stopper keeps presses that mean "select / press / type" from reaching the
  // scene's camera/gesture handlers. Installed first so it runs before any
  // other same-target listener.
  //
  // `pointerdown` is forwarded from this same capture listener rather than a
  // bubble-phase one: the stopper and the forwarder coexist on one element,
  // and jsdom's at-target dispatch suppresses the bubble listener once the
  // capture listener stops propagation (measured: [capture] only), while
  // browsers run both. Single-listener capture forward behaves identically in
  // both (forward, then stop ancestors in selection mode), so there is no
  // environment-dependent branch. `mousedown`/`touchstart` stay pure stops —
  // they have no Vecto equivalent; the press itself arrives as `pointerdown`.
  const pressCapture = (e: Event): void => {
    if (e.type === 'pointerdown') {
      const id = (e as PointerEvent).pointerId ?? 0;
      if (!gestureOwner.has(id)) gestureOwner.set(id, 'dom');
      options.onGestureStart?.(node.id, id);
      node.dispatchEvent(new VectoJSEvent('pointerdown', node, e, true, undefined, 'dom'));
    }
    if (mode === 'selection') e.stopPropagation();
  };
  for (const type of PRESS_EVENTS) on(type, pressCapture, true);

  for (const type of POINTER_EVENTS) {
    on(type, (e: Event) => {
      if (type === 'pointerup' || type === 'pointercancel') {
        const id = (e as PointerEvent).pointerId ?? 0;
        gestureOwner.delete(id);
        options.onGestureEnd?.(node.id, id);
      }
      node.dispatchEvent(new VectoJSEvent(type, node, e, true, undefined, 'dom'));
    });
  }

  const hoverEvents: Array<{ native: string; vecto: VectoEvent }> = [
    { native: 'mouseenter', vecto: 'hover' },
    { native: 'mouseleave', vecto: 'pointerleave' },
  ];
  for (const { native, vecto } of hoverEvents) {
    on(native, (e: Event) => {
      node.dispatchEvent(new VectoJSEvent(vecto, node, e, false, undefined, 'dom'));
    });
  }

  for (const type of ['focus', 'blur']) {
    on(
      type,
      (e: Event) => {
        node.dispatchEvent(new VectoJSEvent(type as VectoEvent, node, e, true, undefined, 'dom'));
      },
      true,
    );
  }

  if (options.editable) {
    const forwardEditable = (e: Event): void => {
      const target = e.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
      if (target && 'value' in target) options.onNativeInput?.(target.value);
      node.dispatchEvent(new VectoJSEvent('change', node, e, true, undefined, 'dom'));
    };
    // Native `input` (each keystroke / IME update) and `change` (commit) both
    // surface as Vecto `'change'`, matching the a11y input-mirror contract.
    on('input', forwardEditable);
    on('change', forwardEditable);
    // IME pre-edit lifecycle rides the same channel; composition payloads stay
    // on the native event for handlers that need them.
    on('compositionstart', forwardEditable);
    on('compositionupdate', forwardEditable);
    on('compositionend', forwardEditable);
  }

  let released = false;
  return {
    setInteractionMode(next: DOMInteractionMode): void {
      mode = next;
    },
    getInteractionMode(): DOMInteractionMode {
      return mode;
    },
    release(): void {
      if (released) return;
      released = true;
      for (const { type, handler, capture } of listeners) {
        el.removeEventListener(type, handler as EventListener, capture);
      }
      listeners.length = 0;
    },
  };
}
