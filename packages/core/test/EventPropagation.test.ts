import { describe, it, expect } from 'vitest';
import { Entity, VectoJSEvent } from '../src/index';

class Node extends Entity {
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

/** parent → mid → leaf chain. */
function chain() {
  const parent = new Node('parent');
  const mid = new Node('mid');
  const leaf = new Node('leaf');
  parent.add(mid);
  mid.add(leaf);
  return { parent, mid, leaf };
}

describe('Entity event propagation', () => {
  it('bubbles from the target up through its ancestors', () => {
    const { parent, mid, leaf } = chain();
    const order: string[] = [];
    leaf.on('click', () => order.push('leaf'));
    mid.on('click', () => order.push('mid'));
    parent.on('click', () => order.push('parent'));

    leaf.dispatchEvent(new VectoJSEvent('click', leaf));

    expect(order).toEqual(['leaf', 'mid', 'parent']);
  });

  it('runs capture listeners root→target before the bubble phase', () => {
    const { parent, mid, leaf } = chain();
    const order: string[] = [];
    parent.on('click', () => order.push('cap-parent'), { capture: true });
    mid.on('click', () => order.push('cap-mid'), { capture: true });
    leaf.on('click', () => order.push('bub-leaf'));
    parent.on('click', () => order.push('bub-parent'));

    leaf.dispatchEvent(new VectoJSEvent('click', leaf));

    expect(order).toEqual(['cap-parent', 'cap-mid', 'bub-leaf', 'bub-parent']);
  });

  it('stopPropagation halts the walk before ancestors run', () => {
    const { mid, leaf } = chain();
    const order: string[] = [];
    leaf.on('click', (e: VectoJSEvent) => {
      order.push('leaf');
      e.stopPropagation();
    });
    mid.on('click', () => order.push('mid'));

    leaf.dispatchEvent(new VectoJSEvent('click', leaf));

    expect(order).toEqual(['leaf']);
  });

  it('stopImmediatePropagation also skips later listeners on the same node', () => {
    const { mid, leaf } = chain();
    const order: string[] = [];
    leaf.on('click', (e: VectoJSEvent) => {
      order.push('leaf-1');
      e.stopImmediatePropagation();
    });
    leaf.on('click', () => order.push('leaf-2'));
    mid.on('click', () => order.push('mid'));

    leaf.dispatchEvent(new VectoJSEvent('click', leaf));

    expect(order).toEqual(['leaf-1']);
  });

  it('exposes target and the moving currentTarget', () => {
    const { parent, leaf } = chain();
    let seen: { t: string; c: string } | undefined;
    parent.on('click', (e: VectoJSEvent) => {
      seen = { t: e.target.id, c: e.currentTarget.id };
    });

    leaf.dispatchEvent(new VectoJSEvent('click', leaf));

    expect(seen).toEqual({ t: 'leaf', c: 'parent' });
  });

  it('a non-bubbling event only fires on the target', () => {
    const { mid, leaf } = chain();
    const order: string[] = [];
    leaf.on('pointerleave', () => order.push('leaf'));
    mid.on('pointerleave', () => order.push('mid'));

    leaf.dispatchEvent(new VectoJSEvent('pointerleave', leaf, undefined, false));

    expect(order).toEqual(['leaf']);
  });

  it('preventDefault and field reads delegate to the wrapped native event', () => {
    const { leaf } = chain();
    let prevented = false;
    const native = {
      deltaY: 42,
      preventDefault: () => (prevented = true),
      defaultPrevented: false,
    };
    let dy: number | undefined;
    leaf.on('wheel', (e: VectoJSEvent) => {
      dy = e.deltaY;
      e.preventDefault();
    });

    leaf.dispatchEvent(new VectoJSEvent('wheel', leaf, native));

    expect(dy).toBe(42);
    expect(prevented).toBe(true);
  });

  it('exposes viewport, scene, local, and modifier coordinates independently', () => {
    const { parent, mid, leaf } = chain();
    parent.setPosition(50, 20);
    mid.setPosition(10, 5);
    leaf.setPosition(3, 2);
    (parent as unknown as { _scene: unknown })._scene = {
      clientToScene(clientX: number, clientY: number) {
        return { x: (clientX - 100) * 2, y: (clientY - 50) * 2 };
      },
    };

    const native = {
      clientX: 300,
      clientY: 200,
      shiftKey: true,
      ctrlKey: true,
      altKey: false,
      metaKey: true,
    };
    const seen: Array<Record<string, number | boolean | undefined>> = [];
    leaf.on('pointerdown', (e: VectoJSEvent) => {
      seen.push({
        clientX: e.clientX,
        clientY: e.clientY,
        sceneX: e.sceneX,
        sceneY: e.sceneY,
        localX: e.localX,
        localY: e.localY,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
      });
    });

    leaf.dispatchEvent(new VectoJSEvent('pointerdown', leaf, native));

    expect(seen).toEqual([
      {
        clientX: 300,
        clientY: 200,
        sceneX: 400,
        sceneY: 300,
        localX: 337,
        localY: 273,
        shiftKey: true,
        ctrlKey: true,
        altKey: false,
        metaKey: true,
      },
    ]);
  });

  it('uses explicit logical scene coordinates for offscreen adapter events', () => {
    const { leaf } = chain();
    leaf.setPosition(20, 30);
    const event = new VectoJSEvent('pointermove', leaf, { clientX: 900, clientY: 700 }, true, {
      x: 120,
      y: 80,
    });

    expect(event.clientX).toBe(900);
    expect(event.clientY).toBe(700);
    expect(event.sceneX).toBe(120);
    expect(event.sceneY).toBe(80);
    expect(event.localX).toBe(100);
    expect(event.localY).toBe(50);
  });

  it('emit() stays a direct, self-only dispatch (back-compat)', () => {
    const { mid, leaf } = chain();
    const order: string[] = [];
    leaf.on('click', () => order.push('leaf'));
    mid.on('click', () => order.push('mid'));

    leaf.emit('click', {});

    expect(order).toEqual(['leaf']); // no bubbling through emit
  });
});
