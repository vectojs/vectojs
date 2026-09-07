// @vitest-environment jsdom
/**
 * Selectable-text exclusion from pointer promotion (RFC3 §6, CTX-0599).
 *
 * The shared semantics/input boundary rule, stated normatively in the RFC: a
 * projected semantic node with `pointer-events: auto` above a selectable text
 * mirror kills native drag-selection, so selectable-text entities are excluded
 * from pointer promotion, and `Text`/`RichText` stay non-interactive by
 * default. Dispatch itself is RFC5 / input-dispatch-contract-v2 territory
 * (CTX-0600) and is NOT touched here — this suite pins the projection half:
 *
 * - a selectable text mirror carries `pointer-events: auto` + `user-select:
 *   text`; a non-selectable one carries `none` (so text never intercepts
 *   canvas input);
 * - an eager selectable-text entity keeps BOTH its semantic mirror and its
 *   selectable text mirror — the exclusion only gates onDemand
 *   pointer-promotion (pinned for onDemand in
 *   `a11yProjectionMode.test.ts`, "does NOT promote an entity that projects
 *   selectable text of its own"), never eager projection.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Entity, Scene, type A11yAttributes, type ContentProjection } from '../src';

function projection(selectable: boolean): ContentProjection {
  const text = 'selectable boundary text';
  return {
    text,
    font: '16px sans-serif',
    lineHeight: 20,
    lines: [{ text, x: 0, y: 0, baseline: 16, font: '16px sans-serif', lineHeight: 20 }],
    selectable,
  };
}

class Paragraph extends Entity {
  constructor(
    id: string,
    private readonly selectable: boolean,
    interactive = false,
  ) {
    super(id);
    this.interactive = interactive;
    this.width = 200;
    this.height = 100;
  }
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
  public override getA11yAttributes(): A11yAttributes {
    return { role: 'button', label: `paragraph ${this.id}` };
  }
  public override getContentProjection(): ContentProjection | null {
    return projection(this.selectable);
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

describe('selectable-text boundary (RFC3 §6)', () => {
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

  it('gives a selectable text mirror pointer-events auto + user-select text', () => {
    const e = new Paragraph('sel', true);
    e.setPosition(10, 10);
    scene.add(e);
    tick();
    const el = scene.getContentElement('sel');
    expect(el).toBeTruthy();
    expect(el!.style.pointerEvents).toBe('auto');
    expect(el!.style.userSelect).toBe('text');
  });

  it('gives a non-selectable text mirror pointer-events none so it never intercepts input', () => {
    const e = new Paragraph('plain', false);
    e.setPosition(10, 10);
    scene.add(e);
    tick();
    const el = scene.getContentElement('plain');
    expect(el).toBeTruthy();
    expect(el!.style.pointerEvents).toBe('none');
    expect(el!.style.userSelect).toBe('none');
  });

  it('keeps an eager selectable-text entity projected WITHOUT disturbing its text mirror', () => {
    // The §6 exclusion gates onDemand pointer-promotion only: an eager entity
    // is projected by definition, and its selectable mirror must stay
    // selectable beside it.
    const e = new Paragraph('eager-sel', true, true);
    e.setPosition(10, 10);
    scene.add(e);
    tick();
    expect(scene.getA11yElement('eager-sel')).toBeTruthy();
    const text = scene.getContentElement('eager-sel');
    expect(text).toBeTruthy();
    expect(text!.style.pointerEvents).toBe('auto');
    expect(text!.style.userSelect).toBe('text');
  });
});
