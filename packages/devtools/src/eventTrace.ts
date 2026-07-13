import { type Entity, type Scene } from '@vectojs/core';
import { entityPath } from './inspect';
import { pickInScene } from './model';

/** Browser inputs observed by the generic development-time routing trace. */
export type EventTraceType =
  'pointerdown' | 'pointerup' | 'pointercancel' | 'pointermove' | 'wheel' | 'keydown' | 'keyup';

/** Where the trace found the routed event. */
export type EventTraceSource = 'a11y' | 'content' | 'canvas' | 'document';

export interface EventTraceModifiers {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
}

/** JSON-safe, immutable summary of one completed browser event dispatch. */
export interface EventTraceEntry {
  readonly type: EventTraceType;
  readonly source: EventTraceSource;
  readonly timeStamp: number;
  readonly targetId?: string;
  readonly targetPath?: string;
  readonly sceneX?: number;
  readonly sceneY?: number;
  readonly localX?: number;
  readonly localY?: number;
  readonly key?: string;
  readonly modifiers: EventTraceModifiers;
  readonly deltaX?: number;
  readonly deltaY?: number;
  readonly defaultPrevented: boolean;
}

export interface EventTraceOptions {
  /** Maximum retained entries. Default 50. */
  capacity?: number;
  /** Include document-level keyboard events for applications with global shortcut routers. Default true. */
  includeGlobalKeyboard?: boolean;
}

type EventTraceListener = (entry: EventTraceEntry) => void;

interface PendingTrace {
  prevented: boolean;
  finalize(): void;
}

const TRACE_TYPES: readonly EventTraceType[] = [
  'pointerdown',
  'pointerup',
  'pointercancel',
  'pointermove',
  'wheel',
  'keydown',
  'keyup',
];

const isKeyboardType = (type: EventTraceType): boolean => type === 'keydown' || type === 'keyup';

/**
 * Observes browser inputs without adding VMT listeners or changing dispatch.
 * Target and document-bubble observers sample `defaultPrevented` after projected
 * VMT routing. Document-bubble records finalize in a microtask; a timer handles
 * native propagation stops without running subscribers inside event dispatch.
 */
export class EventTrace {
  private readonly capacity: number;
  private readonly includeGlobalKeyboard: boolean;
  private readonly records: EventTraceEntry[] = [];
  private readonly listeners = new Set<EventTraceListener>();
  private readonly pendingDefaults = new WeakMap<Event, PendingTrace>();
  private destroyed = false;

  private readonly onEventBubbled = (event: Event): void => {
    const pending = this.pendingDefaults.get(event);
    if (!pending) return;
    pending.prevented ||= event.defaultPrevented;
    queueMicrotask(pending.finalize);
  };

  private readonly onEvent = (event: Event): void => {
    const type = event.type as EventTraceType;
    if (!TRACE_TYPES.includes(type)) return;
    const context = this.resolveContext(event, type);
    if (!context) return;

    const target = event.target;
    let finalized = false;
    const pending: PendingTrace = {
      prevented: event.defaultPrevented,
      finalize: () => {
        if (finalized) return;
        finalized = true;
        target?.removeEventListener(type, observeTargetResult);
        this.pendingDefaults.delete(event);
        if (this.destroyed) return;
        const entry = this.createEntry(event, type, context, pending.prevented);
        this.records.push(entry);
        if (this.records.length > this.capacity) this.records.shift();
        for (const listener of this.listeners) listener(entry);
      },
    };
    const observeTargetResult = (): void => {
      pending.prevented ||= event.defaultPrevented;
    };
    this.pendingDefaults.set(event, pending);
    target?.addEventListener(type, observeTargetResult, { once: true });
    setTimeout(pending.finalize, 0);
  };

  constructor(
    private readonly scene: Scene,
    options: EventTraceOptions = {},
  ) {
    this.capacity = Math.max(1, Math.floor(options.capacity ?? 50));
    this.includeGlobalKeyboard = options.includeGlobalKeyboard ?? true;
    if (typeof document === 'undefined') return;
    for (const type of TRACE_TYPES) {
      document.addEventListener(type, this.onEvent, true);
      document.addEventListener(type, this.onEventBubbled);
    }
  }

  /** Retained records ordered from oldest to newest. */
  public get entries(): readonly EventTraceEntry[] {
    return this.records;
  }

  /** Subscribe to completed records. Returns an idempotent unsubscribe function. */
  public subscribe(listener: EventTraceListener): () => void {
    if (this.destroyed) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Remove retained records without affecting observation. */
  public clear(): void {
    this.records.length = 0;
  }

  /** Stop observing and release subscribers. Safe to call more than once. */
  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (typeof document !== 'undefined') {
      for (const type of TRACE_TYPES) {
        document.removeEventListener(type, this.onEvent, true);
        document.removeEventListener(type, this.onEventBubbled);
      }
    }
    this.listeners.clear();
  }

  private resolveContext(event: Event, type: EventTraceType): TraceContext | null {
    const projected = this.projectedTarget(event.target);
    if (projected) return projected;

    const target = event.target;
    if (target === this.scene.canvas) {
      const point = scenePointOf(this.scene, event);
      return { source: 'canvas', target: point ? pickInScene(this.scene, point.x, point.y) : null };
    }

    if (isKeyboardType(type) && this.includeGlobalKeyboard)
      return { source: 'document', target: null };
    return null;
  }

  private projectedTarget(target: EventTarget | null): TraceContext | null {
    if (!(target instanceof Element)) return null;
    const element = target.closest<HTMLElement>('[data-vecto-content], [data-vecto-id]');
    if (!element) return null;

    const source: EventTraceSource = element.dataset.vectoContent ? 'content' : 'a11y';
    const id = element.dataset.vectoContent ?? element.dataset.vectoId;
    if (!id) return null;
    const projectedElement =
      source === 'content'
        ? typeof this.scene.getContentElement === 'function'
          ? this.scene.getContentElement(id)
          : element.isConnected
            ? element
            : undefined
        : this.scene.getA11yElement(id);
    if (projectedElement !== element) return null;
    const entity =
      findEntityById(this.scene.rootEntity, id) ?? findEntityById(this.scene.overlayRootEntity, id);
    if (!entity || (source === 'content' && !entity.getContentProjection())) return null;
    return { source, target: entity };
  }

  private createEntry(
    event: Event,
    type: EventTraceType,
    context: TraceContext,
    defaultPrevented: boolean,
  ): EventTraceEntry {
    const pointer = scenePointOf(this.scene, event);
    const local =
      context.target && pointer ? context.target.worldToLocal(pointer.x, pointer.y) : null;
    const keyboard = event as KeyboardEvent;
    const wheel = event as WheelEvent;
    return Object.freeze({
      type,
      source: context.source,
      timeStamp: event.timeStamp,
      ...(context.target
        ? { targetId: context.target.id, targetPath: entityPath(context.target) }
        : {}),
      ...(pointer ? { sceneX: pointer.x, sceneY: pointer.y } : {}),
      ...(local ? { localX: local.x, localY: local.y } : {}),
      ...(isKeyboardType(type) ? { key: keyboard.key } : {}),
      modifiers: {
        shift: keyboard.shiftKey,
        ctrl: keyboard.ctrlKey,
        alt: keyboard.altKey,
        meta: keyboard.metaKey,
      },
      ...(type === 'wheel' ? { deltaX: wheel.deltaX, deltaY: wheel.deltaY } : {}),
      defaultPrevented,
    });
  }
}

interface TraceContext {
  source: EventTraceSource;
  target: Entity | null;
}

function scenePointOf(scene: Scene, event: Event): { x: number; y: number } | null {
  const candidate = event as MouseEvent;
  if (typeof candidate.clientX !== 'number' || typeof candidate.clientY !== 'number') return null;
  return scene.clientToScene(candidate.clientX, candidate.clientY);
}

function findEntityById(root: Entity, id: string): Entity | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findEntityById(child, id);
    if (found) return found;
  }
  return null;
}

/** Create a bounded development-time event-routing trace for `scene`. */
export function createEventTrace(scene: Scene, options?: EventTraceOptions): EventTrace {
  return new EventTrace(scene, options);
}
