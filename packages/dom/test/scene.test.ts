// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Scene } from '@vectojs/core';
import { DOMProjection } from '../src/DOMProjection';
import { DOMButton, DOMContainer, DOMText } from '../src/nodes';

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

/** DOMText with an observable canvas paint (the prototype itself no-ops). */
class CountingNode extends DOMText {
  public renders = 0;

  override render(): void {
    this.renders += 1;
  }
}

describe('Scene + DOMProjection integration (RFC §9.1/9.7)', () => {
  let canvas: HTMLCanvasElement;
  let scene: Scene;
  let projection: DOMProjection;

  const tick = () => {
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
    projection = new DOMProjection(canvas);
    scene.addProjectionBackend(projection);
  });

  afterEach(() => {
    projection.dispose();
    scene.destroy();
    canvas.remove();
    document.body.innerHTML = '';
  });

  it('drives canvas + DOM backends from one graph in one frame loop', () => {
    const btn = new DOMButton('btn', 'press me');
    btn.x = 120;
    scene.add(btn);
    tick();
    expect(btn.domResident).toBe(true);
    const el = projection.getElement('btn')!;
    expect(el.tagName.toLowerCase()).toBe('button');
    expect(el.textContent).toBe('press me');
    expect(el.style.transform).toBe('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 120, 0, 0, 1)');
  });

  it('skips canvas paint for resident leaves and creates no a11y mirror', () => {
    const node = new CountingNode('count', 'skim');
    scene.add(node);
    tick();
    expect(node.domResident).toBe(true);
    expect(node.renders).toBe(0);
    expect(scene.getA11yElement('count')).toBeUndefined();
  });

  it('keeps DOM sync when the node moves (camera/scene moves flow through the walk)', () => {
    const node = new CountingNode('mover', 'go');
    scene.add(node);
    tick();
    node.x = 300;
    node.y = 150;
    tick();
    expect(projection.getElement('mover')!.style.transform).toBe(
      'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 300, 150, 0, 1)',
    );
    const writes = projection.getStats().transformWrites;
    tick();
    tick();
    expect(projection.getStats().transformWrites).toBe(writes);
  });

  it('keeps targets correct under rotation', () => {
    const node = new CountingNode('spin', 'turn');
    scene.add(node);
    tick();
    const before = projection.getElement('spin')!.style.transform;
    node.rotation = Math.PI / 2;
    tick();
    const after = projection.getElement('spin')!.style.transform;
    expect(after).not.toBe(before);
    expect(after.startsWith('matrix3d(')).toBe(true);
    // 90° rotation of the unit axes (float-exact through the same composition
    // the canvas path uses — the walk is the single source of both).
    expect(after).toBe(
      'matrix3d(6.123233995736766e-17, 1, 0, 0, -1, 6.123233995736766e-17, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)',
    );
  });

  it('projects nested opt-in descendants through a resident container', () => {
    const container = new DOMContainer('panel', 400, 300);
    const child = new DOMText('nested', 'nested');
    container.add(child);
    scene.add(container);
    tick();
    expect(container.domResident).toBe(true);
    expect(child.domResident).toBe(true);
    expect(projection.getElement('nested')).toBeTruthy();
  });

  it('unmounts synchronously on scene.remove', () => {
    const btn = new DOMButton('gone', 'bye');
    scene.add(btn);
    tick();
    expect(btn.domResident).toBe(true);
    scene.remove(btn);
    expect(btn.domResident).toBe(false);
    expect(projection.getElement('gone')).toBeUndefined();
    expect(document.querySelector('[data-vecto-id="gone"]')).toBeNull();
  });

  it('policy flip back to canvas unmounts and resumes canvas paint', () => {
    const node = new CountingNode('flip', 'flop');
    scene.add(node);
    tick();
    expect(node.domResident).toBe(true);
    expect(node.renders).toBe(0);
    node.domPolicy = 'canvas';
    tick();
    expect(node.domResident).toBe(false);
    expect(projection.getElement('flip')).toBeUndefined();
    expect(node.renders).toBeGreaterThan(0);
  });
});
