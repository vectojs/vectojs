import { describe, it, expect } from 'vitest';
import { Entity, VectoUIEvent } from '../src/index';

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

    leaf.dispatchEvent(new VectoUIEvent('click', leaf));

    expect(order).toEqual(['leaf', 'mid', 'parent']);
  });

  it('runs capture listeners root→target before the bubble phase', () => {
    const { parent, mid, leaf } = chain();
    const order: string[] = [];
    parent.on('click', () => order.push('cap-parent'), { capture: true });
    mid.on('click', () => order.push('cap-mid'), { capture: true });
    leaf.on('click', () => order.push('bub-leaf'));
    parent.on('click', () => order.push('bub-parent'));

    leaf.dispatchEvent(new VectoUIEvent('click', leaf));

    expect(order).toEqual(['cap-parent', 'cap-mid', 'bub-leaf', 'bub-parent']);
  });

  it('stopPropagation halts the walk before ancestors run', () => {
    const { mid, leaf } = chain();
    const order: string[] = [];
    leaf.on('click', (e: VectoUIEvent) => {
      order.push('leaf');
      e.stopPropagation();
    });
    mid.on('click', () => order.push('mid'));

    leaf.dispatchEvent(new VectoUIEvent('click', leaf));

    expect(order).toEqual(['leaf']);
  });

  it('stopImmediatePropagation also skips later listeners on the same node', () => {
    const { mid, leaf } = chain();
    const order: string[] = [];
    leaf.on('click', (e: VectoUIEvent) => {
      order.push('leaf-1');
      e.stopImmediatePropagation();
    });
    leaf.on('click', () => order.push('leaf-2'));
    mid.on('click', () => order.push('mid'));

    leaf.dispatchEvent(new VectoUIEvent('click', leaf));

    expect(order).toEqual(['leaf-1']);
  });

  it('exposes target and the moving currentTarget', () => {
    const { parent, leaf } = chain();
    let seen: { t: string; c: string } | undefined;
    parent.on('click', (e: VectoUIEvent) => {
      seen = { t: e.target.id, c: e.currentTarget.id };
    });

    leaf.dispatchEvent(new VectoUIEvent('click', leaf));

    expect(seen).toEqual({ t: 'leaf', c: 'parent' });
  });

  it('a non-bubbling event only fires on the target', () => {
    const { mid, leaf } = chain();
    const order: string[] = [];
    leaf.on('pointerleave', () => order.push('leaf'));
    mid.on('pointerleave', () => order.push('mid'));

    leaf.dispatchEvent(new VectoUIEvent('pointerleave', leaf, undefined, false));

    expect(order).toEqual(['leaf']);
  });

  it('preventDefault and field reads delegate to the wrapped native event', () => {
    const { leaf } = chain();
    let prevented = false;
    const native = { deltaY: 42, preventDefault: () => (prevented = true), defaultPrevented: false };
    let dy: number | undefined;
    leaf.on('wheel', (e: VectoUIEvent) => {
      dy = e.deltaY;
      e.preventDefault();
    });

    leaf.dispatchEvent(new VectoUIEvent('wheel', leaf, native));

    expect(dy).toBe(42);
    expect(prevented).toBe(true);
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
