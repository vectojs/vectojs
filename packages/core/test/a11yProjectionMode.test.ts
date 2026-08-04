// @vitest-environment jsdom
/**
 * Per-entity `a11yProjection` mode (CTX-0196).
 *
 * `'eager'` (default) is today's behaviour. `'onDemand'` withholds the shadow
 * node until the entity is *engaged*, which is what makes thousands of ephemeral
 * interactive entities affordable — measured 72.2 ms/frame (Chrome) and 114.3 ms
 * (Firefox) at 5,000 eager entities against 1.55/1.63 ms for one projected node.
 *
 * The tests that matter most here are the ones pinning that engagement is NOT
 * hover-only, because a hover-only trigger withholds semantics from keyboard and
 * assistive-technology users specifically — the exact failure that made the
 * original hover-gating proposal in #343 unshippable.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Entity, Scene, type A11yAttributes } from '../src';

class Widget extends Entity {
  constructor(id: string) {
    super(id);
    this.interactive = true;
    this.width = 100;
    this.height = 50;
  }
  /**
   * Real containment, not a constant `true`.
   *
   * A blanket `true` makes every hit-test match regardless of position, which
   * would let the pointer-engagement tests pass for the wrong reason.
   */
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

describe('a11yProjection modes', () => {
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

  it("defaults to 'eager' so existing scenes are unchanged", () => {
    const e = new Widget('w');
    expect(e.a11yProjection).toBe('eager');
    scene.add(e);
    tick();
    expect(scene.getA11yElement('w')).toBeTruthy();
  });

  it("'never' suppresses the node while keeping the entity interactive", () => {
    const e = new Widget('w');
    e.a11yProjection = 'never';
    scene.add(e);
    tick();
    expect(scene.getA11yElement('w')).toBeFalsy();
    // Still interactive, so canvas hit-testing and pointer events are unaffected.
    expect(e.interactive).toBe(true);
    expect(scene.findEntityAt(10, 10)).toBe(e);
  });

  it("'onDemand' withholds the node until something engages it", () => {
    const e = new Widget('w');
    e.a11yProjection = 'onDemand';
    scene.add(e);
    tick();
    expect(scene.getA11yElement('w')).toBeFalsy();
    // But it remains hit-testable, so a click can still reach and promote it.
    expect(scene.findEntityAt(10, 10)).toBe(e);
  });

  it('projects an onDemand entity on explicit request, and prunes it on release', () => {
    const e = new Widget('w');
    e.a11yProjection = 'onDemand';
    scene.add(e);
    tick();
    expect(scene.getA11yElement('w')).toBeFalsy();

    scene.requestA11yProjection(e);
    tick();
    expect(scene.getA11yElement('w')).toBeTruthy();

    scene.releaseA11yProjection(e);
    tick();
    expect(scene.getA11yElement('w')).toBeFalsy();
  });

  it('accepts an id as well as an entity, and is idempotent', () => {
    const e = new Widget('w');
    e.a11yProjection = 'onDemand';
    scene.add(e);
    scene.requestA11yProjection('w');
    scene.requestA11yProjection('w');
    tick();
    expect(scene.getA11yElement('w')).toBeTruthy();
    // Releasing something never requested must not throw or disturb others.
    scene.releaseA11yProjection('absent');
    tick();
    expect(scene.getA11yElement('w')).toBeTruthy();
  });

  it('keeps a FOCUSED onDemand node projected, so focus is never yanked away', () => {
    // The decisive accessibility case: a keyboard/AT user generates no hover, and
    // pruning the element that currently holds focus moves focus to <body>,
    // silently dropping the user out of the scene mid-interaction.
    const e = new Widget('w');
    e.a11yProjection = 'onDemand';
    scene.add(e);
    scene.requestA11yProjection(e);
    tick();
    const el = scene.getA11yElement('w')!;
    expect(el).toBeTruthy();

    el.focus();
    expect(document.activeElement).toBe(el);

    // Drop the request while focused: the node must survive on focus alone.
    scene.releaseA11yProjection(e);
    tick();
    expect(scene.getA11yElement('w')).toBeTruthy();
    expect(document.activeElement).toBe(el);
  });

  it('projects the entity under the pointer without any DOM hover', () => {
    // Pointer engagement is resolved by canvas hit-testing, not by asking the DOM
    // what is hovered — an onDemand entity has no element to receive a hover, so a
    // DOM-hover test could never promote it.
    const e = new Widget('w');
    e.a11yProjection = 'onDemand';
    scene.add(e);
    tick();
    expect(scene.getA11yElement('w')).toBeFalsy();

    const s = scene as unknown as { mouseX: number; mouseY: number };
    s.mouseX = 10;
    s.mouseY = 10;
    tick(); // latches hasOnDemandA11y
    tick(); // resolves the pointer target
    expect(scene.getA11yElement('w')).toBeTruthy();
  });

  it('does not project an onDemand entity that is merely near the pointer', () => {
    const e = new Widget('w');
    e.a11yProjection = 'onDemand';
    e.setPosition(500, 400);
    scene.add(e);
    const s = scene as unknown as { mouseX: number; mouseY: number };
    s.mouseX = 10;
    s.mouseY = 10;
    tick();
    tick();
    expect(scene.getA11yElement('w')).toBeFalsy();
  });

  it('leaves eager siblings projected while onDemand ones are withheld', () => {
    const eager = new Widget('eager');
    const lazy = new Widget('lazy');
    lazy.a11yProjection = 'onDemand';
    lazy.setPosition(200, 0);
    scene.add(eager);
    scene.add(lazy);
    tick();
    expect(scene.getA11yElement('eager')).toBeTruthy();
    expect(scene.getA11yElement('lazy')).toBeFalsy();
    // One shadow node for two interactive entities is the whole point.
    expect(scene.a11yElements.size).toBe(1);
  });

  it('has no effect on an eager entity when a request is made', () => {
    const e = new Widget('w');
    scene.add(e);
    scene.requestA11yProjection(e);
    tick();
    expect(scene.getA11yElement('w')).toBeTruthy();
    scene.releaseA11yProjection(e);
    tick();
    // Eager means always projected; a released request must not remove it.
    expect(scene.getA11yElement('w')).toBeTruthy();
  });

  it('does NOT promote an entity that projects selectable text of its own', () => {
    // Regression, caught by the real-browser e2e: such an entity's a11y node
    // carries pointer-events: auto and stacks above its transparent text mirror,
    // so materializing one under the pointer swallows the mousedown and native
    // drag-selection never starts. Measured on Firefox as the correct element
    // under the pointer with an EMPTY selection. This is the same conflict that
    // makes Text/RichText set interactive = false.
    class SelectableCell extends Widget {
      override getContentProjection() {
        return { text: 'Alpha', font: '16px sans-serif', selectable: true };
      }
    }
    const cell = new SelectableCell('cell');
    cell.a11yProjection = 'onDemand';
    scene.add(cell);

    const s = scene as unknown as { mouseX: number; mouseY: number };
    s.mouseX = 10;
    s.mouseY = 10;
    tick();
    tick();
    expect(scene.getA11yElement('cell')).toBeFalsy();

    // Still reachable by the non-pointer routes, so nothing is lost.
    scene.requestA11yProjection(cell);
    tick();
    expect(scene.getA11yElement('cell')).toBeTruthy();
  });

  it('excludes withheld onDemand entities from the public a11y tree', () => {
    const e = new Widget('w');
    e.a11yProjection = 'onDemand';
    scene.add(e);
    tick();
    const before = JSON.stringify(scene.getA11yTree());
    expect(before).not.toContain('widget w');

    scene.requestA11yProjection(e);
    tick();
    // getA11yTree walks the same predicate, so the snapshot must agree with the
    // DOM rather than describing nodes that are not there.
    expect(JSON.stringify(scene.getA11yTree())).toContain('widget w');
  });
});
