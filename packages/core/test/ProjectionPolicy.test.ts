// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  Entity,
  Scene,
  hysteresisVote,
  resolveProjection,
  PROJECTION_AUTO_DOM_BUDGET,
  PROJECTION_AUTO_HYSTERESIS_FRAMES,
  type ProjectionBackend,
  type ProjectionCapabilityRow,
} from '../src';

function fakeCtx(): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'measureText') return () => ({ width: 10 });
        if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
        if (prop === 'canvas') return { width: 0, height: 0, style: {} };
        return () => {};
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
}

class Block extends Entity {
  public renders = 0;

  constructor(id: string, domKind = '') {
    super(id);
    this.domKind = domKind;
    this.width = 200;
    this.height = 24;
    this.interactive = true;
  }

  override getBounds(): { x: number; y: number; width: number; height: number } | null {
    return { x: 0, y: 0, width: this.width, height: this.height };
  }

  override isPointInside(): boolean {
    return true;
  }

  override render(): void {
    this.renders += 1;
  }
}

const DOM_ROW: ProjectionCapabilityRow = {
  domSupported: true,
  nativeValue: 'high',
  domCost: 'medium',
  canvasCost: 'high',
  autoDefault: 'dom',
};
const CANVAS_ROW: ProjectionCapabilityRow = {
  domSupported: true,
  nativeValue: 'medium',
  domCost: 'low',
  canvasCost: 'low',
  autoDefault: 'canvas',
};

/** Non-materializing stand-in: records calls, sets residency like the real one. */
function fakeDomBackend(): ProjectionBackend & {
  updates: number;
  mounts: number;
  unmounts: number;
} {
  const backend = {
    kind: 'dom' as const,
    updates: 0,
    mounts: 0,
    unmounts: 0,
    mount(node: Entity): void {
      backend.mounts += 1;
      node.domResident = true;
    },
    update(node: Entity): void {
      backend.updates += 1;
      if (!node.domResident) {
        backend.mounts += 1;
        node.domResident = true;
      }
    },
    unmount(node: Entity): void {
      backend.unmounts += 1;
      node.domResident = false;
    },
  };
  return backend;
}

describe('resolveProjection pure rules (RFC4 §3)', () => {
  const ctx = { hasDOM: true, domBackendMounted: true };

  it('canvas want is never second-guessed', () => {
    expect(resolveProjection('canvas', DOM_ROW, ctx)).toEqual({ resolved: 'canvas', reason: null });
  });

  it('explicit dom is honoured when possible; cost is the author choice', () => {
    expect(resolveProjection('dom', DOM_ROW, ctx)).toEqual({ resolved: 'dom', reason: null });
    // Even a high canvas-cost-tilted row: explicit beats automatic.
    expect(resolveProjection('dom', CANVAS_ROW, ctx)).toEqual({ resolved: 'dom', reason: null });
  });

  it('no backend reports no-dom-backend, never silently', () => {
    expect(resolveProjection('dom', DOM_ROW, { hasDOM: true, domBackendMounted: false })).toEqual({
      resolved: 'canvas',
      reason: 'no-dom-backend',
    });
    expect(resolveProjection('auto', DOM_ROW, { hasDOM: true, domBackendMounted: false })).toEqual({
      resolved: 'canvas',
      reason: 'no-dom-backend',
    });
  });

  it('no-DOM environments short-circuit before the matrix', () => {
    expect(resolveProjection('auto', DOM_ROW, { hasDOM: false, domBackendMounted: true })).toEqual({
      resolved: 'canvas',
      reason: 'no-dom-backend',
    });
  });

  it('unsupported kinds fall back reported', () => {
    const shader: ProjectionCapabilityRow = {
      domSupported: false,
      nativeValue: 'none',
      domCost: 'unsupported',
      canvasCost: 'low',
      autoDefault: 'canvas',
    };
    expect(resolveProjection('dom', shader, ctx)).toEqual({
      resolved: 'canvas',
      reason: 'unsupported-kind',
    });
    expect(resolveProjection('auto', shader, ctx)).toEqual({
      resolved: 'canvas',
      reason: 'unsupported-kind',
    });
  });

  it('prohibitive DOM cost is the only cell overriding explicit dom', () => {
    const particles: ProjectionCapabilityRow = {
      domSupported: true,
      nativeValue: 'none',
      domCost: 'prohibitive',
      canvasCost: 'low',
      autoDefault: 'canvas',
    };
    expect(resolveProjection('dom', particles, ctx)).toEqual({
      resolved: 'canvas',
      reason: 'prohibitive-cost',
    });
  });

  it('auto weighs interaction value against cost, resting on the row default', () => {
    // high native value, affordable DOM → dom.
    expect(resolveProjection('auto', DOM_ROW, ctx).resolved).toBe('dom');
    // prohibitive canvas cost (inputs) → dom even at medium value.
    const input: ProjectionCapabilityRow = {
      domSupported: true,
      nativeValue: 'high',
      domCost: 'low',
      canvasCost: 'prohibitive',
      autoDefault: 'dom',
    };
    expect(resolveProjection('auto', input, ctx).resolved).toBe('dom');
    // cheap either way → the table default (button leans dom, short text canvas).
    const button: ProjectionCapabilityRow = {
      domSupported: true,
      nativeValue: 'medium',
      domCost: 'low',
      canvasCost: 'low',
      autoDefault: 'dom',
    };
    expect(resolveProjection('auto', button, ctx).resolved).toBe('dom');
    expect(resolveProjection('auto', CANVAS_ROW, ctx).resolved).toBe('canvas');
  });
});

describe('hysteresisVote (RFC4 §3 rule 3)', () => {
  it('first placement always commits', () => {
    expect(hysteresisVote(undefined, 'dom', 0, PROJECTION_AUTO_HYSTERESIS_FRAMES)).toEqual({
      resolved: 'dom',
      consecutive: 0,
      flipped: false,
    });
  });

  it('agreement resets the counter', () => {
    expect(hysteresisVote('canvas', 'canvas', 2, 3)).toEqual({
      resolved: 'canvas',
      consecutive: 0,
      flipped: false,
    });
  });

  it('dissent accumulates until N consecutive, then flips', () => {
    let state = { resolved: 'canvas' as const, consecutive: 0 };
    const vote = (desired: 'canvas' | 'dom'): void => {
      const next = hysteresisVote(state.resolved, desired, state.consecutive, 3);
      state = { resolved: next.resolved, consecutive: next.consecutive };
    };
    vote('dom');
    expect(state).toEqual({ resolved: 'canvas', consecutive: 1 });
    vote('dom');
    expect(state).toEqual({ resolved: 'canvas', consecutive: 2 });
    // An agreeing vote in the middle resets — oscillation never accumulates.
    vote('canvas');
    expect(state).toEqual({ resolved: 'canvas', consecutive: 0 });
    vote('dom');
    vote('dom');
    vote('dom');
    expect(state).toEqual({ resolved: 'dom', consecutive: 0 });
  });
});

describe('Scene.resolveProjectionFor (CTX-0601 wiring)', () => {
  let canvas: HTMLCanvasElement;
  let scene: Scene;

  const tick = (): void => {
    (scene as unknown as { isRunning: boolean }).isRunning = true;
    (scene as unknown as { loop: (t: number) => void }).loop(0);
  };

  beforeEach(() => {
    HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as never;
    canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    document.body.appendChild(canvas);
    scene = new Scene(canvas, { maxFPS: 0 });
    scene.renderMode = 'always';
  });

  afterEach(() => {
    scene.destroy();
    canvas.remove();
    document.body.innerHTML = '';
  });

  it('canvas policy never touches backends and records nothing (byte-identical)', () => {
    const backend = fakeDomBackend();
    scene.addProjectionBackend(backend);
    const node = new Block('c1', 'prose');
    scene.add(node);
    tick();
    tick();
    expect(backend.updates).toBe(0);
    expect(node.renders).toBeGreaterThan(0);
    expect(scene.getProjectionResolution('c1')).toEqual({
      nodeId: 'c1',
      want: 'canvas',
      resolved: 'canvas',
      reason: null,
    });
  });

  it('with no backends, non-default policies report no-dom-backend', () => {
    const node = new Block('n1', 'prose');
    node.domPolicy = 'auto';
    scene.add(node);
    tick();
    expect(scene.getProjectionResolution('n1')).toEqual({
      nodeId: 'n1',
      want: 'auto',
      resolved: 'canvas',
      reason: 'no-dom-backend',
    });
    expect(node.domResident).toBe(false);
  });

  it('auto prose resolves dom with a backend; auto text stays canvas', () => {
    scene.addProjectionBackend(fakeDomBackend());
    const prose = new Block('p1', 'prose');
    prose.domPolicy = 'auto';
    const short = new Block('t1', 'text');
    short.domPolicy = 'auto';
    scene.add(prose);
    scene.add(short);
    tick();
    expect(scene.getProjectionResolution('p1')?.resolved).toBe('dom');
    expect(prose.domResident).toBe(true);
    expect(scene.getProjectionResolution('t1')).toEqual({
      nodeId: 't1',
      want: 'auto',
      resolved: 'canvas',
      reason: null,
    });
    expect(short.domResident).toBe(false);
  });

  it('a dom-resolved auto node loses its a11y mirror like explicit dom', () => {
    scene.addProjectionBackend(fakeDomBackend());
    const node = new Block('m1', 'prose');
    node.domPolicy = 'auto';
    scene.add(node);
    tick();
    expect(scene.getProjectionResolution('m1')?.resolved).toBe('dom');
    expect(scene.getA11yElement('m1')).toBeUndefined();
  });

  it('hysteresis prevents flip-flop under oscillating costs', () => {
    scene.addProjectionBackend(fakeDomBackend());
    scene.projectionHysteresisFrames = 3;
    scene.registerProjectionCapability('osc', { ...CANVAS_ROW });
    const node = new Block('o1', 'osc');
    node.domPolicy = 'auto';
    scene.add(node);
    tick();
    expect(scene.getProjectionResolution('o1')?.resolved).toBe('canvas');
    // Oscillate every frame: canvas, dom, canvas, dom — never N consecutive.
    for (let i = 0; i < 6; i++) {
      scene.registerProjectionCapability('osc', { ...(i % 2 === 0 ? DOM_ROW : CANVAS_ROW) });
      tick();
      expect(scene.getProjectionResolution('o1')?.resolved).toBe('canvas');
      // Dissent frames report the stickiness; agreeing frames reset to null.
      if (i % 2 === 0) expect(scene.getProjectionResolution('o1')?.reason).toBe('hysteresis');
    }
    // Three consecutive dom votes commit the flip.
    scene.registerProjectionCapability('osc', { ...DOM_ROW });
    tick();
    tick();
    tick();
    expect(scene.getProjectionResolution('o1')?.resolved).toBe('dom');
  });

  it('an explicit gesture pin holds the backend with reason active-gesture', () => {
    scene.addProjectionBackend(fakeDomBackend());
    scene.projectionHysteresisFrames = 1;
    scene.registerProjectionCapability('g1k', { ...CANVAS_ROW });
    const node = new Block('g1', 'g1k');
    node.domPolicy = 'auto';
    scene.add(node);
    tick();
    expect(scene.getProjectionResolution('g1')?.resolved).toBe('canvas');
    scene.pinProjectionForGesture(node);
    scene.registerProjectionCapability('g1k', { ...DOM_ROW });
    tick();
    expect(scene.getProjectionResolution('g1')).toEqual({
      nodeId: 'g1',
      want: 'auto',
      resolved: 'canvas',
      reason: 'active-gesture',
    });
    scene.unpinProjectionForGesture(node);
    tick();
    expect(scene.getProjectionResolution('g1')?.resolved).toBe('dom');
  });

  it('a backend-reported gesture pins the same way', () => {
    const backend = fakeDomBackend();
    let gesture = false;
    (backend as unknown as Record<string, unknown>).hasActiveGesture = () => gesture;
    scene.addProjectionBackend(backend);
    scene.projectionHysteresisFrames = 1;
    scene.registerProjectionCapability('g2k', { ...CANVAS_ROW });
    const node = new Block('g2', 'g2k');
    node.domPolicy = 'auto';
    scene.add(node);
    tick();
    gesture = true;
    scene.registerProjectionCapability('g2k', { ...DOM_ROW });
    tick();
    expect(scene.getProjectionResolution('g2')?.reason).toBe('active-gesture');
    expect(scene.getProjectionResolution('g2')?.resolved).toBe('canvas');
  });

  it('bulk backstop: auto placements stop at the budget, explicit dom bypasses', () => {
    scene.addProjectionBackend(fakeDomBackend());
    scene.projectionAutoDomBudget = 2;
    const nodes = ['b1', 'b2', 'b3'].map((id) => {
      const node = new Block(id, 'prose');
      node.domPolicy = 'auto';
      scene.add(node);
      return node;
    });
    const explicit = new Block('b4', 'short-circuit-check');
    explicit.domPolicy = 'dom';
    explicit.domKind = 'prose';
    scene.add(explicit);
    tick();
    expect(nodes.map((n) => scene.getProjectionResolution(n.id)?.resolved)).toEqual([
      'dom',
      'dom',
      'canvas',
    ]);
    expect(scene.getProjectionResolution('b3')?.reason).toBe('bulk-budget');
    expect(scene.getProjectionResolution('b4')?.resolved).toBe('dom');
  });

  it('default tunables match the documented constants', () => {
    expect(scene.projectionHysteresisFrames).toBe(PROJECTION_AUTO_HYSTERESIS_FRAMES);
    expect(scene.projectionAutoDomBudget).toBe(PROJECTION_AUTO_DOM_BUDGET);
  });

  it('projectionCapabilities exposes the precedent-shaped surface', () => {
    scene.addProjectionBackend(fakeDomBackend());
    expect(scene.projectionCapabilities).toEqual({
      hasDOM: true,
      domBackendMounted: true,
      backends: ['dom'],
      autoHysteresisFrames: PROJECTION_AUTO_HYSTERESIS_FRAMES,
      autoDomBudget: PROJECTION_AUTO_DOM_BUDGET,
    });
  });

  it('removal clears negotiation records', () => {
    scene.addProjectionBackend(fakeDomBackend());
    const node = new Block('r1', 'prose');
    node.domPolicy = 'auto';
    scene.add(node);
    tick();
    expect(scene.getProjectionResolution('r1')).toBeDefined();
    scene.remove(node);
    expect(scene.getProjectionResolution('r1')).toBeUndefined();
    // The scene root itself is walked (and recorded) every frame — removal
    // clears the removed node's records, not the whole surface.
    expect(scene.getProjectionResolutions().map((r) => r.nodeId)).not.toContain('r1');
  });

  it('focused node keeps its backend with reason focus-pinned, never drops focus', () => {
    scene.addProjectionBackend(fakeDomBackend());
    scene.projectionHysteresisFrames = 1;
    scene.registerProjectionCapability('f1k', { ...CANVAS_ROW });
    const node = new Block('f1', 'f1k');
    node.domPolicy = 'auto';
    scene.add(node);
    tick();
    // Materialize the canvas-policy mirror, then take focus on it.
    (scene as unknown as { syncA11y: (root: unknown) => void }).syncA11y(
      (scene as unknown as { root: unknown }).root,
    );
    const mirror = scene.getA11yElement('f1');
    expect(mirror).toBeDefined();
    // A bare Block mirror carries no tab stop (real controls do); make it
    // programmatically focusable so the test exercises the focus-owns-pin path.
    mirror!.setAttribute('tabindex', '-1');
    mirror!.focus();
    expect(document.activeElement).toBe(mirror);
    // Costs now say dom, but focus pins the node to canvas.
    scene.registerProjectionCapability('f1k', { ...DOM_ROW });
    tick();
    expect(scene.getProjectionResolution('f1')).toEqual({
      nodeId: 'f1',
      want: 'auto',
      resolved: 'canvas',
      reason: 'focus-pinned',
    });
    // Move focus elsewhere (a bare blur() is a no-op in jsdom — focus must be
    // *moved*, which is also the real-world path); the flip commits and focus
    // never hit body mid-way.
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    expect(document.activeElement).toBe(elsewhere);
    tick();
    expect(scene.getProjectionResolution('f1')?.resolved).toBe('dom');
    expect(document.activeElement).not.toBe(document.body);
  });
});
