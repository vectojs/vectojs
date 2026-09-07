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
    expect(getGestureOwner(7)).toBe('dom');
    const up = new Event('pointerup', { bubbles: true }) as PointerEvent;
    (up as unknown as Record<string, number>).pointerId = 7;
    el.dispatchEvent(up);
    expect(getGestureOwner(7)).toBeUndefined();
    bridge.release();
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
});
