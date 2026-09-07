// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Entity, type VectoJSEvent } from '@vectojs/core';
import { attachDOMBridge, getGestureOwner } from '../src/eventBridge';
import { DOMInput } from '../src/nodes';

class ProbeNode extends Entity {
  override isPointInside(): boolean {
    return true;
  }

  override render(): void {}
}

describe('DOM event bridge (RFC §6, DOMPortalEntity precedent)', () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
  });

  it('forwards clicks with source attribution, exactly once', () => {
    const node = new ProbeNode('b1');
    const el = document.createElement('button');
    host.appendChild(el);
    const seen: VectoJSEvent[] = [];
    node.on('click', (e: VectoJSEvent) => seen.push(e));
    const bridge = attachDOMBridge(el, node);
    el.click();
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe('click');
    expect(seen[0].target).toBe(node);
    expect(seen[0].source).toBe('dom');
    bridge.release();
  });

  it('maps hover events with bubble=false like the portal bridge', () => {
    const node = new ProbeNode('b2');
    const el = document.createElement('div');
    host.appendChild(el);
    const seen: VectoJSEvent[] = [];
    node.on('hover', (e: VectoJSEvent) => seen.push(e));
    const bridge = attachDOMBridge(el, node);
    el.dispatchEvent(new Event('mouseenter', { bubbles: false }));
    expect(seen).toHaveLength(1);
    expect(seen[0].bubbles).toBe(false);
    expect(seen[0].source).toBe('dom');
    bridge.release();
  });

  it('stops content presses in selection mode, passes them in orbit mode', () => {
    const node = new ProbeNode('b3');
    const el = document.createElement('div');
    host.appendChild(el);
    let parentPresses = 0;
    host.addEventListener('pointerdown', () => {
      parentPresses += 1;
    });
    const bridge = attachDOMBridge(el, node);
    expect(bridge.getInteractionMode()).toBe('selection');
    el.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(parentPresses).toBe(0);
    bridge.setInteractionMode('orbit');
    el.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(parentPresses).toBe(1);
    bridge.release();
  });

  it('elects one gesture owner per pointerId until release', () => {
    const node = new ProbeNode('b4');
    const el = document.createElement('div');
    host.appendChild(el);
    const bridge = attachDOMBridge(el, node);
    const down = new Event('pointerdown', { bubbles: true }) as PointerEvent;
    (down as unknown as Record<string, number>).pointerId = 7;
    el.dispatchEvent(down);
    // The election names the owning node (r7: per-node attribution), and the
    // bridge instance records its own pin.
    expect(getGestureOwner(7)).toBe('b4');
    expect(bridge.hasGesture(7)).toBe(true);
    const up = new Event('pointerup', { bubbles: true }) as PointerEvent;
    (up as unknown as Record<string, number>).pointerId = 7;
    el.dispatchEvent(up);
    expect(getGestureOwner(7)).toBeUndefined();
    expect(bridge.hasGesture(7)).toBe(false);
    bridge.release();
  });

  it('attributes the election to the pressing node (r7)', () => {
    const a = new ProbeNode('nA');
    const b = new ProbeNode('nB');
    const elA = document.createElement('div');
    const elB = document.createElement('div');
    host.append(elA, elB);
    const bridgeA = attachDOMBridge(elA, a);
    const bridgeB = attachDOMBridge(elB, b);
    const down = new Event('pointerdown', { bubbles: true }) as PointerEvent;
    (down as unknown as Record<string, number>).pointerId = 31;
    elB.dispatchEvent(down);
    expect(getGestureOwner(31)).toBe('nB');
    expect(bridgeB.hasGesture(31)).toBe(true);
    expect(bridgeA.hasGesture(31)).toBe(false);
    bridgeA.release();
    bridgeB.release();
  });

  it('scopes releases per bridge: one scene never clears another live gesture (r7)', () => {
    const a = new ProbeNode('mA');
    const b = new ProbeNode('mB');
    const elA = document.createElement('div');
    const elB = document.createElement('div');
    host.append(elA, elB);
    const bridgeA = attachDOMBridge(elA, a);
    const bridgeB = attachDOMBridge(elB, b);
    const press = (el: HTMLElement, pointerId: number): void => {
      const down = new Event('pointerdown', { bubbles: true }) as PointerEvent;
      (down as unknown as Record<string, number>).pointerId = pointerId;
      el.dispatchEvent(down);
    };
    const release = (el: HTMLElement, pointerId: number): void => {
      const up = new Event('pointerup', { bubbles: true }) as PointerEvent;
      (up as unknown as Record<string, number>).pointerId = pointerId;
      el.dispatchEvent(up);
    };
    // Same pointerId pressed on both scenes: first elector wins the global
    // record, both bridges hold their own pin.
    press(elA, 32);
    expect(getGestureOwner(32)).toBe('mA');
    press(elB, 32);
    expect(getGestureOwner(32)).toBe('mA');
    expect(bridgeA.hasGesture(32)).toBe(true);
    expect(bridgeB.hasGesture(32)).toBe(true);
    // The non-owner's release drops only its own pin — the live gesture stays.
    release(elB, 32);
    expect(bridgeB.hasGesture(32)).toBe(false);
    expect(getGestureOwner(32)).toBe('mA');
    expect(bridgeA.hasGesture(32)).toBe(true);
    // The owner's release ends the election.
    release(elA, 32);
    expect(getGestureOwner(32)).toBeUndefined();
    expect(bridgeA.hasGesture(32)).toBe(false);
    bridgeA.release();
    bridgeB.release();
  });

  it('release drops mid-gesture pins instead of leaking them (r7)', () => {
    const node = new ProbeNode('r1');
    const el = document.createElement('div');
    host.appendChild(el);
    const bridge = attachDOMBridge(el, node);
    const down = new Event('pointerdown', { bubbles: true }) as PointerEvent;
    (down as unknown as Record<string, number>).pointerId = 33;
    el.dispatchEvent(down);
    expect(getGestureOwner(33)).toBe('r1');
    // No pointerup ever arrives (element torn down mid-gesture): release must
    // clear the pin rather than reporting a stale owner forever.
    bridge.release();
    expect(bridge.hasGesture(33)).toBe(false);
    expect(getGestureOwner(33)).toBeUndefined();
  });

  it('syncs native input back to the node and forwards change', () => {
    const node = new DOMInput('i1', 'ab');
    const el = document.createElement('input');
    host.appendChild(el);
    const seen: VectoJSEvent[] = [];
    node.on('change', (e: VectoJSEvent) => seen.push(e));
    const received: string[] = [];
    const bridge = attachDOMBridge(el, node, {
      editable: true,
      onNativeInput: (v) => {
        received.push(v);
        (node as unknown as Record<string, unknown>).value = v;
      },
    });
    el.value = 'abc';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    expect(node.value).toBe('abc');
    expect(received).toEqual(['abc']);
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe('change');
    expect(seen[0].source).toBe('dom');
    bridge.release();
  });

  it('release is idempotent and detaches everything', () => {
    const node = new ProbeNode('b5');
    const el = document.createElement('button');
    host.appendChild(el);
    let clicks = 0;
    node.on('click', () => {
      clicks += 1;
    });
    const bridge = attachDOMBridge(el, node);
    bridge.release();
    bridge.release();
    el.click();
    expect(clicks).toBe(0);
  });

  it('reports gesture start/end with node id and pointer id (RFC4 §5)', () => {
    const node = new ProbeNode('b6');
    const el = document.createElement('div');
    host.appendChild(el);
    const calls: Array<[string, string, number]> = [];
    const bridge = attachDOMBridge(el, node, {
      onGestureStart: (nodeId, pointerId) => calls.push(['start', nodeId, pointerId]),
      onGestureEnd: (nodeId, pointerId) => calls.push(['end', nodeId, pointerId]),
    });
    const down = new Event('pointerdown', { bubbles: true }) as PointerEvent;
    (down as unknown as Record<string, number>).pointerId = 11;
    el.dispatchEvent(down);
    const up = new Event('pointerup', { bubbles: true }) as PointerEvent;
    (up as unknown as Record<string, number>).pointerId = 11;
    el.dispatchEvent(up);
    expect(calls).toEqual([
      ['start', 'b6', 11],
      ['end', 'b6', 11],
    ]);
    bridge.release();
  });
});
