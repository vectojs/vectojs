// @vitest-environment jsdom
/**
 * `SemanticProjectionPolicy` seams (RFC3 §5, CTX-0599, closes #849).
 *
 * The semantic tier decides per node at exactly one place —
 * `Scene.shouldProjectA11y` — and this suite pins that the policy seam wired
 * there changes nothing out of the box while giving future backends (and
 * tests) a per-node `project | defer-to-browser | never` vote:
 *
 * - framework-known default is `'project'` (zero behaviour change);
 * - `'never'` suppresses, through every consumer of the predicate;
 * - `'defer-to-browser'` falls back to projection until a real backend
 *   exists (`supportsHTMLInCanvas()` is `false`), for plain text and
 *   controls alike;
 * - a throwing policy can never drop semantics;
 * - `defer-to-browser` is allow-listed per content class and never the
 *   default for controls (`isDeferrableSemanticNode`).
 *
 * Lifecycle, dispatch, and the `A11yAttributes` shape are owned elsewhere
 * (lazy-a11y-projection-design, input-dispatch-contract-v2,
 * content/reference/core-a11y) and are not re-argued here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SEMANTIC_PROJECTION_POLICY,
  describeHTMLInCanvasSupport,
  Entity,
  getSemanticProjectionCapabilities,
  isDeferrableSemanticNode,
  Scene,
  supportsHTMLInCanvas,
  type A11yAttributes,
  type ContentProjection,
  type SemanticProjectionPolicy,
} from '../src';

class Widget extends Entity {
  constructor(id: string) {
    super(id);
    this.interactive = true;
    this.width = 100;
    this.height = 50;
  }
  isPointInside(x: number, y: number): boolean {
    const local = this.worldToLocal(x, y);
    if (!local) return false;
    return local.x >= 0 && local.y >= 0 && local.x <= this.width && local.y <= this.height;
  }
  render(): void {}
  public getA11yAttributes(): A11yAttributes {
    return { role: 'button', label: `widget ${this.id}` };
  }
}

/** Plain display-text semantics: no control role, no tab stop, not selectable. */
class PlainNote extends Widget {
  public override getA11yAttributes(): A11yAttributes {
    return { label: `note ${this.id}` };
  }
}

class SelectableNote extends PlainNote {
  public override getContentProjection(): ContentProjection | null {
    return { text: 'select me', font: '16px sans-serif', lineHeight: 20, selectable: true };
  }
}

function fakeCtx(): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'measureText') return (t: string) => ({ width: t.length * 8 });
        if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
        if (prop === 'canvas') return { width: 0, height: 0, style: {} };
        return () => {};
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
}

function neverPolicy(): SemanticProjectionPolicy {
  return { choose: () => 'never' };
}

function deferPolicy(): SemanticProjectionPolicy {
  return { choose: () => 'defer-to-browser' };
}

describe('SemanticProjectionPolicy seams', () => {
  let canvas: HTMLCanvasElement;
  let scene: Scene;

  const tick = (): void => {
    (scene as unknown as { isRunning: boolean }).isRunning = true;
    (scene as unknown as { loop: (t: number) => void }).loop(0);
  };

  beforeEach(() => {
    const ctx = fakeCtx();
    HTMLCanvasElement.prototype.getContext = (() => ctx) as never;
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
  });

  it('defaults to the framework-known project policy, changing nothing', () => {
    expect(scene.semanticProjectionPolicy).toBe(DEFAULT_SEMANTIC_PROJECTION_POLICY);
    expect(DEFAULT_SEMANTIC_PROJECTION_POLICY.choose).toBeDefined();
    const e = new Widget('w');
    scene.add(e);
    tick();
    expect(scene.getA11yElement('w')).toBeTruthy();
    expect(JSON.stringify(scene.getA11yTree())).toContain('widget w');
  });

  it('passes the node, live capabilities, and environment to choose', () => {
    const seen: unknown[] = [];
    const policy: SemanticProjectionPolicy = {
      choose: (node, capabilities, environment) => {
        seen.push([node, capabilities, environment]);
        return 'project';
      },
    };
    scene.semanticProjectionPolicy = policy;
    const e = new Widget('w');
    scene.add(e);
    tick();
    // Once per consumer of the predicate per frame (sync walk, DOM order,
    // render z-order, …) — every call must see the same (node, caps, env).
    expect(seen.length).toBeGreaterThanOrEqual(1);
    for (const [node, capabilities, environment] of seen as Array<
      [Entity, Record<string, unknown>, Record<string, unknown>]
    >) {
      expect(node).toBe(e);
      expect(capabilities).toEqual({ htmlInCanvas: false, canvasTextRecovery: false });
      expect(environment).toEqual({ hasDOM: true });
    }
    expect(scene.getA11yElement('w')).toBeTruthy();
  });

  it("a 'never' decision suppresses an eager node through every consumer", () => {
    scene.semanticProjectionPolicy = neverPolicy();
    const e = new Widget('w');
    scene.add(e);
    tick();
    expect(scene.getA11yElement('w')).toBeFalsy();
    expect(JSON.stringify(scene.getA11yTree())).not.toContain('widget w');
  });

  it('restoring the default policy re-projects a policy-suppressed node', () => {
    scene.semanticProjectionPolicy = neverPolicy();
    const e = new Widget('w');
    scene.add(e);
    tick();
    expect(scene.getA11yElement('w')).toBeFalsy();
    scene.semanticProjectionPolicy = DEFAULT_SEMANTIC_PROJECTION_POLICY;
    tick();
    expect(scene.getA11yElement('w')).toBeTruthy();
  });

  it("a 'never' decision holds for an engaged onDemand node", () => {
    const e = new Widget('w');
    e.a11yProjection = 'onDemand';
    scene.add(e);
    scene.requestA11yProjection(e);
    tick();
    expect(scene.getA11yElement('w')).toBeTruthy();
    scene.semanticProjectionPolicy = neverPolicy();
    tick();
    expect(scene.getA11yElement('w')).toBeFalsy();
  });

  it('accepts the policy as a constructor option', () => {
    const policy = neverPolicy();
    const s2 = new Scene(canvas, { maxFPS: 0, semanticProjectionPolicy: policy });
    try {
      expect(s2.semanticProjectionPolicy).toBe(policy);
    } finally {
      s2.destroy();
    }
  });

  it("'defer-to-browser' falls back to projection until a backend exists", () => {
    // No deferral backend exists, so deferring would silently drop semantics
    // (RFC §3) — the Scene must project instead, for plain text and controls.
    expect(supportsHTMLInCanvas()).toBe(false);
    scene.semanticProjectionPolicy = deferPolicy();
    const plain = new PlainNote('plain');
    const control = new Widget('control');
    scene.add(plain);
    scene.add(control);
    tick();
    expect(scene.getA11yElement('plain')).toBeTruthy();
    expect(scene.getA11yElement('control')).toBeTruthy();
  });

  it('a throwing policy falls back to projection instead of dropping semantics', () => {
    scene.semanticProjectionPolicy = {
      choose: () => {
        throw new Error('policy blew up');
      },
    };
    const e = new Widget('w');
    scene.add(e);
    tick();
    expect(scene.getA11yElement('w')).toBeTruthy();
  });

  it('allow-lists deferral per content class, never for controls', () => {
    // Plain display text (no role, no tab stop) is the first allow-listed
    // class; everything with control semantics stays framework-projected.
    expect(isDeferrableSemanticNode(new PlainNote('plain'))).toBe(true);
    expect(isDeferrableSemanticNode(new Widget('control'))).toBe(false);
    class TabStop extends PlainNote {
      public override getA11yAttributes(): A11yAttributes {
        return { label: 'stop', tabIndex: 0 };
      }
    }
    expect(isDeferrableSemanticNode(new TabStop('stop'))).toBe(false);
    class NativeInput extends PlainNote {
      public override getA11yAttributes(): A11yAttributes {
        return { tag: 'input', inputType: 'text' };
      }
    }
    expect(isDeferrableSemanticNode(new NativeInput('input'))).toBe(false);
    // Natively selectable text keeps its DOM mirror (RFC §6 boundary).
    expect(isDeferrableSemanticNode(new SelectableNote('sel'))).toBe(false);
  });

  it('reports html-in-canvas support honestly: false until a real backend', () => {
    expect(supportsHTMLInCanvas()).toBe(false);
    expect(describeHTMLInCanvasSupport()).toEqual({ supported: false, reason: 'no-backend' });
    expect(getSemanticProjectionCapabilities()).toEqual({
      htmlInCanvas: false,
      canvasTextRecovery: false,
    });
  });
});
