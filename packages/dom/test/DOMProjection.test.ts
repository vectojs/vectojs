// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Entity } from '@vectojs/core';
import { DOMProjection } from '../src/DOMProjection';

class ProbeNode extends Entity {
  public text = 'hello';
  public label = 'press';
  public value = 'typed';

  constructor(id: string) {
    super(id);
    this.domPolicy = 'dom';
    this.domKind = 'text';
    this.width = 200;
    this.height = 24;
  }

  override isPointInside(): boolean {
    return true;
  }

  override render(): void {}
}

describe('DOMProjection lifecycle (RFC §4)', () => {
  let canvas: HTMLCanvasElement;
  let projection: DOMProjection;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    projection = new DOMProjection(canvas);
  });

  afterEach(() => {
    projection.dispose();
    canvas.remove();
    document.body.innerHTML = '';
  });

  it('creates the visual root below the a11y layer', () => {
    const root = projection.getRoot();
    expect(root).toBeTruthy();
    expect(root!.style.zIndex).toBe('9');
    expect(root!.style.pointerEvents).toBe('none');
  });

  it('inserts the root before a11yRoot when present', () => {
    projection.dispose();
    const a11y = document.createElement('div');
    a11y.setAttribute('data-vecto-a11y-root', '');
    canvas.parentElement!.appendChild(a11y);
    projection = new DOMProjection(canvas);
    const root = projection.getRoot()!;
    expect(root.nextElementSibling).toBe(a11y);
  });

  it('mounts a live element with the mandatory origin and id', () => {
    const node = new ProbeNode('t1');
    projection.update(node, { a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 });
    expect(node.domResident).toBe(true);
    const el = projection.getElement('t1')!;
    expect(el).toBeTruthy();
    expect(el.getAttribute('data-vecto-id')).toBe('t1');
    expect(el.style.position).toBe('absolute');
    expect(el.style.transformOrigin).toBe('0 0');
    expect(el.style.transform).toBe('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 0, 1)');
    expect(el.textContent).toBe('hello');
    expect(el.style.userSelect).toBe('text');
  });

  it('dirty-checks: steady-state frames write nothing', () => {
    const node = new ProbeNode('t2');
    const m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    projection.update(node, m);
    const afterFirst = projection.getStats();
    expect(afterFirst.transformWrites).toBe(1);
    expect(afterFirst.contentWrites).toBe(1);
    projection.update(node, { ...m });
    projection.update(node, { ...m });
    const afterSteady = projection.getStats();
    expect(afterSteady.transformWrites).toBe(1);
    expect(afterSteady.contentWrites).toBe(1);
  });

  it('rewrites the transform on move (rotate/scale persistence)', () => {
    const node = new ProbeNode('t3');
    projection.update(node, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    projection.update(node, { a: 0, b: 1, c: -1, d: 0, e: 40, f: 50 });
    expect(projection.getStats().transformWrites).toBe(2);
    expect(projection.getElement('t3')!.style.transform).toBe(
      'matrix3d(0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 40, 50, 0, 1)',
    );
  });

  it('unmounts and pools the element for reuse', () => {
    const node = new ProbeNode('t4');
    projection.update(node, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    const first = projection.getElement('t4')!;
    projection.unmount(node);
    expect(node.domResident).toBe(false);
    expect(document.querySelector('[data-vecto-id="t4"]')).toBeNull();
    expect(projection.getStats().unmounts).toBe(1);
    // Idempotent: a second unmount is a no-op, not a second stat.
    projection.unmount(node);
    expect(projection.getStats().unmounts).toBe(1);
    // Re-mount claims the pooled element.
    projection.update(node, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    expect(projection.getStats().poolHits).toBe(1);
    expect(projection.getElement('t4')).toBe(first);
    expect(projection.getElement('t4')!.textContent).toBe('hello');
  });

  it('falls back focus to the sentinel when unmounting a focused subtree', () => {
    const node = new ProbeNode('t5');
    node.domKind = 'input';
    projection.update(node, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    const el = projection.getElement('t5') as HTMLInputElement;
    el.focus();
    expect(document.activeElement).toBe(el);
    projection.unmount(node);
    expect(document.activeElement).not.toBe(el);
    expect(document.activeElement?.getAttribute('aria-hidden')).toBe('true');
  });

  it('supports custom kinds via registerKind', () => {
    const node = new ProbeNode('t6');
    node.domKind = 'badge';
    projection.registerKind('badge', {
      tag: 'span',
      create: () => document.createElement('span'),
      sync: (n, el, fields) => {
        fields.write('text', (n as unknown as { text: string }).text, (v) => {
          el.textContent = `(${v})`;
        });
      },
    });
    projection.update(node, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    const el = projection.getElement('t6')!;
    expect(el.tagName.toLowerCase()).toBe('span');
    expect(el.textContent).toBe('(hello)');
  });

  it('never goes resident without a DOM parent (canvas fallback)', () => {
    const orphan = document.createElement('canvas');
    const ssrLike = new DOMProjection(orphan);
    expect(ssrLike.getRoot()).toBeNull();
    const node = new ProbeNode('t7');
    ssrLike.update(node, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    expect(node.domResident).toBe(false);
    ssrLike.dispose();
  });
});
