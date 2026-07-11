import { describe, expect, it } from 'vitest';
import { Entity, Scene, type A11yAttributes, type ContentProjection } from '@vectojs/core';
import { createEventTrace } from '../src/index';

class Box extends Entity {
  constructor(id: string) {
    super(id);
    this.width = 80;
    this.height = 40;
    this.interactive = true;
  }

  getA11yAttributes(): A11yAttributes {
    return { role: 'button', label: 'Trace target' };
  }

  isPointInside(sceneX: number, sceneY: number): boolean {
    const point = this.worldToLocal(sceneX, sceneY);
    return (
      point !== null &&
      point.x >= 0 &&
      point.y >= 0 &&
      point.x < this.width &&
      point.y < this.height
    );
  }

  render(): void {}
}

class ContentBox extends Entity {
  constructor(id: string) {
    super(id);
    this.width = 100;
    this.height = 30;
  }

  getContentProjection(): ContentProjection {
    return { text: 'Selectable content', selectable: true };
  }

  render(): void {}
}

function makeHost(): Scene {
  const parent = document.createElement('div');
  const canvas = document.createElement('canvas');
  parent.appendChild(canvas);
  document.body.appendChild(parent);
  const scene = new Scene(canvas, { disableWindowResize: true });
  scene.resize(200, 120);
  return scene;
}

function syncA11y(scene: Scene): void {
  (scene as unknown as { syncA11y(root: Entity): void }).syncA11y(scene.getRoot());
}

describe('EventTrace', () => {
  it('records a11y events after application handlers prevent their default', async () => {
    const host = makeHost();
    const target = new Box('a11y-target');
    target.setPosition(10, 12);
    target.on('pointerdown', (event: { preventDefault(): void }) => event.preventDefault());
    host.add(target);
    syncA11y(host);
    const trace = createEventTrace(host);

    host.getA11yElement(target.id)!.dispatchEvent(
      new MouseEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        clientX: 24,
        clientY: 30,
      }),
    );
    await Promise.resolve();

    expect(trace.entries).toEqual([
      expect.objectContaining({
        type: 'pointerdown',
        source: 'a11y',
        targetId: target.id,
        targetPath: expect.stringContaining('Box#a11y-t'),
        defaultPrevented: true,
      }),
    ]);
    trace.destroy();
    host.destroy();
  });

  it('attributes projected selectable-text events to the owning entity', async () => {
    const host = makeHost();
    const target = new ContentBox('content-target');
    target.setPosition(8, 10);
    host.add(target);
    syncA11y(host);
    const trace = createEventTrace(host);
    const content = (
      host as unknown as { contentElements: Map<string, HTMLElement> }
    ).contentElements.get(target.id)!;
    const nested = document.createElement('span');
    content.appendChild(nested);
    nested.addEventListener('pointerdown', (event) => event.preventDefault());

    nested.dispatchEvent(
      new MouseEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        clientX: 28,
        clientY: 24,
      }),
    );
    await Promise.resolve();

    expect(trace.entries).toEqual([
      expect.objectContaining({
        type: 'pointerdown',
        source: 'content',
        targetId: target.id,
        targetPath: expect.stringContaining('ContentBox#content-'),
        sceneX: 28,
        sceneY: 24,
        localX: 20,
        localY: 14,
        defaultPrevented: true,
      }),
    ]);
    trace.destroy();
    host.destroy();
  });

  it('picks canvas events and evicts the oldest records at capacity', async () => {
    const host = makeHost();
    const target = new Box('canvas-target');
    host.add(target);
    const trace = createEventTrace(host, { capacity: 2 });

    host.canvas.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 20 }),
    );
    host.canvas.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'A' }));
    host.canvas.dispatchEvent(
      new KeyboardEvent('keyup', { bubbles: true, key: 'A', shiftKey: true }),
    );
    await Promise.resolve();

    expect(trace.entries).toEqual([
      expect.objectContaining({ type: 'keydown', source: 'canvas', key: 'A' }),
      expect.objectContaining({
        type: 'keyup',
        source: 'canvas',
        key: 'A',
        modifiers: { shift: true, ctrl: false, alt: false, meta: false },
      }),
    ]);
    trace.destroy();
    host.destroy();
  });

  it('notifies subscribers until destroyed and does not retain later events', async () => {
    const host = makeHost();
    const trace = createEventTrace(host);
    const received: string[] = [];
    trace.subscribe((entry) => received.push(entry.type));

    host.canvas.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    await Promise.resolve();
    trace.destroy();
    host.canvas.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
    await Promise.resolve();

    expect(received).toEqual(['keydown']);
    expect(trace.entries).toHaveLength(1);
    host.destroy();
  });
});
