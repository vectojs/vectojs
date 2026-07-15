// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { ContextMenu } from '../src/ContextMenu';
import { Scene } from '@vectojs/core';

describe('ContextMenu', () => {
  const fillTextCalls: { text: string; x: number }[] = [];

  beforeEach(() => {
    fillTextCalls.length = 0;
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type: string) {
      if (type === '2d') {
        return {
          font: '',
          fillStyle: '',
          // Deterministic width so the right-alignment math is checkable.
          measureText: (text: string) => ({ width: text.length * 7 }),
          fillText: (text: string, x: number) => fillTextCalls.push({ text, x }),
          scale: () => {},
          clearRect: () => {},
          save: () => {},
          restore: () => {},
          translate: () => {},
          rotate: () => {},
          beginPath: () => {},
          rect: () => {},
          clip: () => {},
          moveTo: () => {},
          lineTo: () => {},
          stroke: () => {},
          fill: () => {},
          roundRect: () => {},
        } as any;
      }
      return originalGetContext.apply(this, arguments as any);
    };
  });

  function setup() {
    const canvas = document.createElement('canvas');
    const scene = new Scene(canvas);
    const menu = new ContextMenu({
      width: 220,
      items: [{ label: 'Copy', shortcut: 'Ctrl+C' }, { label: 'Inspect' }],
    });
    scene.overlayRoot.add(menu);
    return { scene, menu };
  }

  it('right-aligns the shortcut hint instead of overflowing the panel', () => {
    const { menu } = setup();
    menu.showAtPoint(10, 10);
    const noop = () => {};
    menu.render({
      beginPath: noop,
      roundRect: noop,
      fill: noop,
      stroke: noop,
      moveTo: noop,
      lineTo: noop,
      fillText: (t: string, x: number) => fillTextCalls.push({ text: t, x }),
    } as any);

    const shortcutCall = fillTextCalls.find((c) => c.text === 'Ctrl+C');
    expect(shortcutCall).toBeDefined();
    // width(220) - 12 inset - measured width (6 chars * 7 = 42)
    expect(shortcutCall!.x).toBe(220 - 12 - 42);
  });

  it('mounts a full-screen backdrop while open and removes it on hide', () => {
    const { scene, menu } = setup();
    expect((menu as any)._backdrop).toBeNull();

    menu.showAtPoint(10, 10);
    expect((menu as any)._backdrop).not.toBeNull();
    expect(scene.overlayRoot.children).toContain((menu as any)._backdrop);

    menu.hide();
    expect((menu as any)._backdrop).toBeNull();
  });

  it('closes when the backdrop (a click outside the menu) fires', () => {
    const { menu } = setup();
    menu.showAtPoint(10, 10);
    expect(menu.visible).toBe(true);

    const backdrop = (menu as any)._backdrop;
    backdrop.emit('click', { stopPropagation: () => {} });

    expect(menu.visible).toBe(false);
    expect((menu as any)._backdrop).toBeNull();
  });

  it('does not leak a second backdrop when reopened without an intervening hide', () => {
    const { scene, menu } = setup();
    menu.showAtPoint(10, 10);
    const firstBackdrop = (menu as any)._backdrop;
    menu.showAtPoint(20, 20);
    expect((menu as any)._backdrop).toBe(firstBackdrop);
    expect(scene.overlayRoot.children.filter((c) => c === firstBackdrop).length).toBe(1);
  });

  it('still selects an item and closes normally (no regression from the backdrop)', () => {
    const { scene } = setup();
    let clicked = false;
    const clickable = new ContextMenu({
      width: 220,
      items: [{ label: 'Copy', onClick: () => (clicked = true) }],
    });
    scene.overlayRoot.add(clickable);
    clickable.showAtPoint(10, 10);
    clickable.emit('pointerdown', { localY: 10 });
    expect(clicked).toBe(true);
    expect(clickable.visible).toBe(false);
  });
});
