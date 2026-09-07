import type { AffineTransform, Entity, ProjectionBackend } from '@vectojs/core';
import { attachDOMBridge, type DOMBridgeHandle, type DOMBridgeOptions } from './eventBridge';
import { affineToMatrix3d } from './matrix';

/** Layer of the DOM-visual root: the `portalRoot` family, below a11y (RFC §7). */
export const DOM_VISUAL_Z_INDEX = '9';

/** Attribute marking the DOM-visual root and every projected element. */
export const DOM_ROOT_ATTR = 'data-vecto-dom-root';

/** Maximum pooled elements kept per tag (RFC §4.1 tag-keyed pool). */
const POOL_CAP_PER_TAG = 8;

/** Telemetry counters (also the dirty-check assertions tests pin). */
export interface DOMProjectionStats {
  mounts: number;
  unmounts: number;
  transformWrites: number;
  opacityWrites: number;
  sizeWrites: number;
  contentWrites: number;
  poolHits: number;
  poolMisses: number;
}

/**
 * Dirty-checked field writer handed to kind specs (RFC §4.2,
 * `A11yAttributes` precedent: `undefined` removes, values write only on
 * change). Returns true when the DOM was actually touched.
 */
export interface DOMSyncFields {
  write(key: string, next: string | undefined, apply: (value: string | undefined) => void): boolean;
}

/**
 * Creation + content contract for one `domKind` (RFC §4.1 step 1).
 *
 * This registry is the boundary-rule answer to "custom nodes supply
 * `createDOMElement()`": that method cannot live on core `Entity` (it would be
 * new `HTMLElement` surface in core), so custom kinds register here per
 * projection instance. `sync` must touch the DOM only on change (via
 * `fields`) so steady-state frames write nothing (RFC §4.2).
 */
export interface DOMKindSpec {
  /** Element tag (pool key; must match what `create` returns). */
  tag: string;
  /** Create (not pool — pooling is the backend's job) the element for `node`. */
  create(node: Entity): HTMLElement;
  /** Sync node content/attributes into `el`, dirty-checked via `fields`. */
  sync(node: Entity, el: HTMLElement, fields: DOMSyncFields): void;
}

/** Read an unknown node property as a string, for kind-agnostic content sync. */
function strProp(node: Entity, key: string): string | undefined {
  const value = (node as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Single-field dirty check behind {@link DOMSyncFields}. `undefined` means
 * "remove" and is cached distinctly from any string, so a removed-then-absent
 * field does not re-apply every frame.
 */
export function writeField(
  cached: Map<string, string>,
  key: string,
  next: string | undefined,
  apply: (value: string | undefined) => void,
  onWrite?: () => void,
): boolean {
  const prev = cached.get(key);
  // Absent-vs-present is cached distinctly (prefix-tagged) so a removed field
  // does not re-apply every frame, and no real prop value can collide.
  const nextKey = next === undefined ? '@removed' : `@value:${next}`;
  if (prev === nextKey) return false;
  cached.set(key, nextKey);
  apply(next);
  onWrite?.();
  return true;
}

const textSpec: DOMKindSpec = {
  tag: 'div',
  create(_node: Entity): HTMLElement {
    const el = document.createElement('div');
    el.style.userSelect = 'text';
    return el;
  },
  sync(node: Entity, el: HTMLElement, fields: DOMSyncFields): void {
    fields.write('text', strProp(node, 'text') ?? '', (v) => {
      el.textContent = v ?? '';
    });
  },
};

const buttonSpec: DOMKindSpec = {
  tag: 'button',
  create(_node: Entity): HTMLElement {
    return document.createElement('button');
  },
  sync(node: Entity, el: HTMLElement, fields: DOMSyncFields): void {
    fields.write('label', strProp(node, 'label') ?? '', (v) => {
      el.textContent = v ?? '';
    });
  },
};

const inputSpec: DOMKindSpec = {
  tag: 'input',
  create(_node: Entity): HTMLElement {
    return document.createElement('input');
  },
  sync(node: Entity, el: HTMLElement, fields: DOMSyncFields): void {
    const input = el as HTMLInputElement;
    // Never clobber the focused value: the browser owns the caret and the IME
    // pre-edit while focused, and a framework write would jump both. The
    // bridge's native `input` listener is the source of truth meanwhile.
    if (document.activeElement !== el) {
      fields.write('value', strProp(node, 'value') ?? '', (v) => {
        input.value = v ?? '';
      });
    }
    fields.write('placeholder', strProp(node, 'placeholder'), (v) => {
      if (v === undefined) input.removeAttribute('placeholder');
      else input.setAttribute('placeholder', v);
    });
  },
};

const passthroughSpec = (tag: string): DOMKindSpec => ({
  tag,
  create(_node: Entity): HTMLElement {
    return document.createElement(tag);
  },
  sync(_node: Entity, _el: HTMLElement, _fields: DOMSyncFields): void {},
});

/** Shared fallback for unknown `domKind`s (avoids one alloc per update). */
const fallbackSpec = passthroughSpec('div');

interface DOMNodeState {
  el: HTMLElement;
  bridge: DOMBridgeHandle;
  observer: ResizeObserver | null;
  tag: string;
  cached: Map<string, string>;
  lastTransform: string;
  lastOpacity: string;
  lastWidth: string;
  lastHeight: string;
  intrinsicWidth: number;
  intrinsicHeight: number;
}

/**
 * The `DOMProjection` (`'dom'`) backend (RFC §§4/5/6/7, P1 prototype).
 *
 * The scene keeps owning nodes, layout, visibility, lifecycle, and events;
 * this backend owns _how a `'dom'`-policy node appears_: one live
 * `HTMLElement` per resident node under a dedicated root, positioned per frame
 * by the node's world matrix as CSS `matrix3d()` with `transform-origin: 0 0`.
 *
 * Layer rule (RFC §7): cross-backend ordering is layer-based, never
 * pixel-depth-based. The root joins the `portalRoot` family at `zIndex 9`,
 * below `a11yRoot` at 10 — a projected node at `position.z = -500` still
 * paints over canvas content, by design, with no per-pixel occlusion.
 *
 * Only 100% browser/display zoom is supported (inherited CSS3DRenderer limit,
 * RFC §5 rule 5): non-100% zoom misaligns `matrix3d` spacing (upstream
 * `mrdoob/three.js#3225`). Documented, not fixed.
 */
export class DOMProjection implements ProjectionBackend {
  readonly kind = 'dom' as const;

  private root: HTMLDivElement | null = null;
  private sentinel: HTMLDivElement | null = null;
  private readonly states = new Map<string, DOMNodeState>();
  private readonly pools = new Map<string, HTMLElement[]>();
  private readonly kinds = new Map<string, DOMKindSpec>();
  private readonly bridgeOptions: DOMBridgeOptions;
  /** Nodes owning a live press: `pointerId`s per node id (RFC4 §5 pin source). */
  private readonly activeGestures = new Map<string, Set<number>>();
  private mountSeq = 0;
  private readonly stats: DOMProjectionStats = {
    mounts: 0,
    unmounts: 0,
    transformWrites: 0,
    opacityWrites: 0,
    sizeWrites: 0,
    contentWrites: 0,
    poolHits: 0,
    poolMisses: 0,
  };

  /**
   * @param canvas - The scene's canvas. The root is appended to its
   *   `parentElement` (inserted before `a11yRoot` when present so the
   *   below-a11y layer holds even on `zIndex` ties). Without a DOM (SSR) or
   *   without a parent, the backend constructs but never goes resident — the
   *   walk then falls through to canvas paint.
   */
  constructor(canvas: HTMLCanvasElement, bridgeOptions: DOMBridgeOptions = {}) {
    this.bridgeOptions = bridgeOptions;
    this.kinds.set('text', textSpec);
    this.kinds.set('button', buttonSpec);
    this.kinds.set('input', inputSpec);
    this.kinds.set('container', passthroughSpec('div'));
    this.kinds.set('transform', passthroughSpec('div'));

    if (typeof document === 'undefined') return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const root = document.createElement('div');
    root.setAttribute(DOM_ROOT_ATTR, '');
    root.style.position = 'absolute';
    root.style.top = '0';
    root.style.left = '0';
    root.style.width = '100%';
    root.style.height = '100%';
    root.style.pointerEvents = 'none';
    root.style.overflow = 'hidden';
    root.style.zIndex = DOM_VISUAL_Z_INDEX;
    // Focus fallback target (RFC §4.3): dropping a focused element without a
    // fallback strands keyboard users. Owned here (not core's sentinel) so no
    // new focus surface is needed in core.
    const sentinel = document.createElement('div');
    sentinel.tabIndex = -1;
    sentinel.setAttribute('aria-hidden', 'true');
    sentinel.style.position = 'absolute';
    sentinel.style.width = '0';
    sentinel.style.height = '0';
    sentinel.style.overflow = 'hidden';
    root.appendChild(sentinel);
    this.sentinel = sentinel;
    const a11yRoot = parent.querySelector('[data-vecto-a11y-root]');
    if (a11yRoot) parent.insertBefore(root, a11yRoot);
    else parent.appendChild(root);
    this.root = root;
  }

  /** Register (or replace) a custom `domKind` (RFC §4.1 custom nodes). */
  registerKind(kind: string, spec: DOMKindSpec): void {
    this.kinds.set(kind, spec);
  }

  /** Telemetry counters (cumulative). */
  getStats(): DOMProjectionStats {
    return { ...this.stats };
  }

  /** The DOM-visual root, if constructed (null under SSR). */
  getRoot(): HTMLDivElement | null {
    return this.root;
  }

  /** Live element for a resident node, if any. */
  getElement(nodeId: string): HTMLElement | undefined {
    return this.states.get(nodeId)?.el;
  }

  /**
   * Whether `node` currently owns an active press on its live element
   * (`ProjectionBackend.hasActiveGesture`, RFC4 §5). The scene consults this
   * during `'auto'` negotiation so a node never flips backends mid-gesture.
   */
  hasActiveGesture(node: Entity): boolean {
    return (this.activeGestures.get(node.id)?.size ?? 0) > 0;
  }

  /** Last ResizeObserver-measured intrinsic size, if observed. */
  getIntrinsicSize(nodeId: string): { width: number; height: number } | undefined {
    const state = this.states.get(nodeId);
    if (!state || state.intrinsicWidth === 0) return undefined;
    return { width: state.intrinsicWidth, height: state.intrinsicHeight };
  }

  /** Resolve the creation spec for a node (custom kinds win; unknown = plain div). */
  private specFor(node: Entity): DOMKindSpec {
    return this.kinds.get(node.domKind) ?? fallbackSpec;
  }

  mount(node: Entity): void {
    if (this.states.has(node.id) || !this.root || typeof document === 'undefined') return;
    const spec = this.specFor(node);
    // Tag-keyed pool claim (RFC §4.1): content is always re-synced through a
    // fresh cache below, so no stale text/value survives reuse; kind-specific
    // setup the pool does not retain is re-applied after claiming.
    let el = this.pools.get(spec.tag)?.pop();
    if (el) {
      this.stats.poolHits += 1;
      if (node.domKind === 'text') el.style.userSelect = 'text';
      el.style.display = '';
    } else {
      this.stats.poolMisses += 1;
      el = spec.create(node);
    }
    el.style.position = 'absolute';
    el.style.left = '0px';
    el.style.top = '0px';
    // MANDATORY (RFC §5 rule 4, same finding as `a11y-dom.ts`): with the
    // default `50% 50%` origin, nested rotated boxes diverge by tens of pixels.
    el.style.transformOrigin = '0 0';
    el.style.pointerEvents = 'auto';
    el.setAttribute('data-vecto-id', node.id);
    this.root.appendChild(el);

    const bridge = attachDOMBridge(el, node, {
      ...this.bridgeOptions,
      editable: node.domKind === 'input' || this.bridgeOptions.editable,
      onGestureStart: (nodeId, pointerId) => {
        this.bridgeOptions.onGestureStart?.(nodeId, pointerId);
        let owned = this.activeGestures.get(nodeId);
        if (!owned) {
          owned = new Set();
          this.activeGestures.set(nodeId, owned);
        }
        owned.add(pointerId);
      },
      onGestureEnd: (nodeId, pointerId) => {
        this.bridgeOptions.onGestureEnd?.(nodeId, pointerId);
        const owned = this.activeGestures.get(nodeId);
        if (owned) {
          owned.delete(pointerId);
          if (owned.size === 0) this.activeGestures.delete(nodeId);
        }
      },
      onNativeInput:
        node.domKind === 'input'
          ? (value: string) => {
              (node as unknown as Record<string, unknown>).value = value;
            }
          : this.bridgeOptions.onNativeInput,
    });

    const state: DOMNodeState = {
      el,
      bridge,
      observer: null,
      tag: spec.tag,
      cached: new Map(),
      lastTransform: '',
      lastOpacity: '',
      lastWidth: '',
      lastHeight: '',
      intrinsicWidth: 0,
      intrinsicHeight: 0,
    };
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver((entries) => {
        const current = this.states.get(node.id);
        if (!current) return;
        for (const entry of entries) {
          current.intrinsicWidth =
            entry.contentRect.width || (entry.target as HTMLElement).offsetWidth;
          current.intrinsicHeight =
            entry.contentRect.height || (entry.target as HTMLElement).offsetHeight;
        }
      });
      observer.observe(el);
      state.observer = observer;
    }
    this.states.set(node.id, state);
    // Stable mount-order z-index (documented P1 simplification): walk order is
    // paint order, so first-mount order matches layering; steady-state frames
    // then write no z-index at all, unlike a per-frame counter.
    el.style.zIndex = String(1 + this.mountSeq++);
    node.domResident = true;
    this.stats.mounts += 1;
  }

  update(node: Entity, worldMatrix: AffineTransform): void {
    let state = this.states.get(node.id);
    if (!state) {
      this.mount(node);
      state = this.states.get(node.id);
      if (!state) return;
    }
    const transformStr = affineToMatrix3d(worldMatrix);
    if (state.lastTransform !== transformStr) {
      state.el.style.transform = transformStr;
      state.lastTransform = transformStr;
      this.stats.transformWrites += 1;
    }
    // World opacity: the interface carries only the matrix, so compose up the
    // ancestor chain here (parents are plain data — no DOM surface involved).
    let opacity = 1;
    let cursor: Entity | null = node;
    let depth = 0;
    while (cursor && depth < 32) {
      opacity *= cursor.opacity;
      cursor = cursor.parent;
      depth += 1;
    }
    const opacityStr = String(opacity);
    if (state.lastOpacity !== opacityStr) {
      state.el.style.opacity = opacityStr;
      state.lastOpacity = opacityStr;
      this.stats.opacityWrites += 1;
    }
    if (node.width > 0 || node.height > 0) {
      const widthStr = node.width > 0 ? `${node.width}px` : '';
      const heightStr = node.height > 0 ? `${node.height}px` : '';
      if (state.lastWidth !== widthStr || state.lastHeight !== heightStr) {
        state.el.style.width = widthStr;
        state.el.style.height = heightStr;
        state.lastWidth = widthStr;
        state.lastHeight = heightStr;
        this.stats.sizeWrites += 1;
      }
    }
    const spec = this.specFor(node);
    const cached = state.cached;
    const fields: DOMSyncFields = {
      write: (key, next, apply) =>
        writeField(cached, key, next, apply, () => {
          this.stats.contentWrites += 1;
        }),
    };
    spec.sync(node, state.el, fields);
  }

  unmount(node: Entity): void {
    const state = this.states.get(node.id);
    // A node torn down mid-gesture (explicit policy flip, removal) will never
    // deliver the matching release — its listeners are gone with the element —
    // so drop the pin here rather than reporting a stale gesture forever.
    this.activeGestures.delete(node.id);
    node.domResident = false;
    if (!state) return;
    // RFC §4.3 focus fallback: a focused element removed without a fallback
    // strands keyboard users. Release the bridge first so the fallback focus
    // itself does not re-enter the node's handlers.
    state.bridge.release();
    if (typeof document !== 'undefined') {
      const active = document.activeElement;
      if (active && active !== document.body && state.el.contains(active)) {
        this.sentinel?.focus({ preventScroll: true });
      }
    }
    state.observer?.disconnect();
    state.el.remove();
    const pool = this.pools.get(state.tag) ?? [];
    if (pool.length < POOL_CAP_PER_TAG) {
      pool.push(state.el);
      this.pools.set(state.tag, pool);
    }
    this.states.delete(node.id);
    this.stats.unmounts += 1;
  }

  /** Unmount every resident node and remove the root (scene teardown). */
  dispose(): void {
    for (const id of [...this.states.keys()]) {
      const state = this.states.get(id);
      if (!state) continue;
      state.bridge.release();
      state.observer?.disconnect();
      state.el.remove();
    }
    this.states.clear();
    this.pools.clear();
    this.activeGestures.clear();
    this.root?.remove();
    this.root = null;
    this.sentinel = null;
  }
}
