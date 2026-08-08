// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { Entity, Scene } from '../src';

/**
 * Regression coverage for selection loss caused by the a11y DOM-order pass
 * MOVING a content-projection carrier.
 *
 * `enforceA11yDomOrder` reorders projected elements into visual reading order
 * with `parent.insertBefore(expected, current)`. On an already-attached node
 * that is a MOVE, and moving a node destroys any `Selection` anchored inside its
 * subtree — the same collateral damage the pass already recognises and repairs
 * for `document.activeElement`.
 *
 * Measured in CTX-0207 against the gallery's streaming transcript: a selection
 * held 176 characters across three sync passes and collapsed in the exact pass
 * that moved its carrier (`removedNodes` and `addedNodes` both recorded the same
 * node, `isConnected` stayed true, and no release/eviction path ran).
 *
 * REPRODUCING THIS NEEDS TWO THINGS AT ONCE, and every earlier attempt at this
 * file missed one of them and passed against the unfixed engine:
 *
 *  1. `a11yNeedsReorder` must be set. A `y` write alone never sets it; the
 *     streaming path sets it by ADDING a block (`Scene.ts` new-carrier branch).
 *  2. The carrier holding the selection must be the node that gets MOVED. The
 *     reorder loop settles slot 0 upward, so inserting a block that sorts
 *     *above* the holder moves the NEW element in front of it and leaves the
 *     holder untouched. The holder is only moved when it sits LATER in the DOM
 *     than its own sorted position, i.e. when content above it reflowed.
 */

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

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as never;
});

/** A selectable, projected block placed at an explicit y. */
class Block extends Entity {
  public text: string;
  constructor(id: string, text: string, y: number) {
    super(id);
    this.text = text;
    this.width = 400;
    this.height = 20;
    this.y = y;
  }
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
  override getContentProjection() {
    return {
      text: this.text,
      font: '16px sans-serif',
      selectable: true,
      lines: [{ text: this.text, x: 0, y: 0, baseline: 14, lineHeight: 20 }],
    };
  }
}

function makeScene(): Scene {
  const parent = document.createElement('div');
  const canvas = document.createElement('canvas');
  parent.appendChild(canvas);
  document.body.appendChild(parent);
  const scene = new Scene(canvas);
  (scene as unknown as { isRunning: boolean }).isRunning = true;
  return scene;
}

const tick = (scene: Scene) => {
  (scene as unknown as { loop(t: number): void }).loop(0);
};

/** The text node holding a block's single projected line. */
const lineTextNode = (el: HTMLElement): Text => el.querySelector('span')!.firstChild as Text;

const domOrder = (parent: Node): string[] =>
  Array.from(parent.childNodes).map(
    (n) => (n as HTMLElement).getAttribute?.('data-vecto-content') ?? 'other',
  );

describe('content selection survives an a11y DOM-order move', () => {
  it('keeps a selection whose carrier is moved by the reorder pass', () => {
    const scene = makeScene();
    const above = new Block('above', 'i was here first', 0);
    const held = new Block('held', 'select this text here', 100);
    scene.add(above);
    scene.add(held);
    tick(scene);

    const el = scene.getContentElement('held');
    expect(el).toBeTruthy();
    const parent = el!.parentNode as HTMLElement;
    expect(domOrder(parent).indexOf('above')).toBeLessThan(domOrder(parent).indexOf('held'));

    const textNode = lineTextNode(el!);
    const selection = window.getSelection()!;
    selection.setBaseAndExtent(textNode, 0, textNode, 6);
    expect(selection.toString()).toBe('select');

    // Content above the selection reflowed, so `held` now sorts FIRST while
    // still sitting second in the DOM...
    held.y = -100;
    // ...and a newly streamed block sets `a11yNeedsReorder`, so the pass runs
    // and has to move `held` up a slot.
    scene.add(new Block('appended', 'freshly streamed block', 500));
    scene.markDirty();
    tick(scene);

    // Precondition: the pass really did move the carrier holding the selection.
    // Without this the test would pass for the wrong reason.
    expect(domOrder(parent).indexOf('held')).toBeLessThan(domOrder(parent).indexOf('above'));

    // The carrier was moved, not rebuilt: same element, same text node, still
    // attached. So no offset remapping is involved — the original endpoints are
    // still valid and the selection must simply survive.
    expect(el!.isConnected).toBe(true);
    expect(scene.getContentElement('held')).toBe(el);
    expect(lineTextNode(el!)).toBe(textNode);

    expect(selection.rangeCount).toBe(1);
    expect(selection.isCollapsed).toBe(false);
    expect(selection.toString()).toBe('select');

    scene.destroy();
  });

  it('keeps a mid-string selection when a growing block above swaps past it', () => {
    const scene = makeScene();
    const grow = new Block('grow', 'streaming head', 0);
    const held = new Block('held', 'first block content', 100);
    scene.add(grow);
    scene.add(held);
    tick(scene);

    const el = scene.getContentElement('held')!;
    const parent = el.parentNode as HTMLElement;
    const node = lineTextNode(el);
    const selection = window.getSelection()!;
    selection.setBaseAndExtent(node, 6, node, 11); // "block"
    expect(selection.toString()).toBe('block');

    // The head grew downward past `held`, so reading order swaps.
    grow.y = 400;
    scene.add(new Block('tail', 'new tail block', 900));
    scene.markDirty();
    tick(scene);

    expect(domOrder(parent).indexOf('held')).toBeLessThan(domOrder(parent).indexOf('grow'));
    expect(selection.toString()).toBe('block');
    scene.destroy();
  });

  it('keeps a selection spanning two carriers when both are moved', () => {
    const scene = makeScene();
    const head = new Block('head', 'heading text', 0);
    const first = new Block('first', 'alpha beta gamma', 100);
    const second = new Block('second', 'delta epsilon zeta', 200);
    scene.add(head);
    scene.add(first);
    scene.add(second);
    tick(scene);

    const firstEl = scene.getContentElement('first')!;
    const secondEl = scene.getContentElement('second')!;
    const parent = firstEl.parentNode as HTMLElement;
    const selection = window.getSelection()!;
    selection.setBaseAndExtent(lineTextNode(firstEl), 6, lineTextNode(secondEl), 5);
    expect(selection.isCollapsed).toBe(false);
    const before = selection.toString();
    expect(before.length).toBeGreaterThan(0);

    // Both selected carriers sort above `head` now, so the pass moves BOTH of
    // them. A restore applied per-move would be undone by the second move.
    first.y = -200;
    second.y = -100;
    scene.add(new Block('tail', 'streamed tail', 900));
    scene.markDirty();
    tick(scene);

    const order = domOrder(parent);
    expect(order.indexOf('first')).toBeLessThan(order.indexOf('head'));
    expect(order.indexOf('second')).toBeLessThan(order.indexOf('head'));

    expect(selection.isCollapsed).toBe(false);
    expect(selection.toString()).toBe(before);
    scene.destroy();
  });

  it('leaves an unrelated selection alone when a different carrier moves', () => {
    const scene = makeScene();
    const held = new Block('held', 'keep my selection', 0);
    const mover = new Block('mover', 'i am the one moving', 100);
    const anchorBlock = new Block('anchor', 'bottom of the page', 200);
    scene.add(held);
    scene.add(mover);
    scene.add(anchorBlock);
    tick(scene);

    const heldEl = scene.getContentElement('held')!;
    const parent = heldEl.parentNode as HTMLElement;
    const node = lineTextNode(heldEl);
    const selection = window.getSelection()!;
    selection.setBaseAndExtent(node, 0, node, 4); // "keep"
    expect(selection.toString()).toBe('keep');

    // `mover` reflows below `anchor` and gets moved; `held` stays put.
    mover.y = 300;
    scene.add(new Block('tail', 'streamed tail', 900));
    scene.markDirty();
    tick(scene);

    const order = domOrder(parent);
    expect(order.indexOf('anchor')).toBeLessThan(order.indexOf('mover'));
    expect(order.indexOf('held')).toBe(0);

    expect(selection.toString()).toBe('keep');
    scene.destroy();
  });
});
