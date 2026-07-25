// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { Modal } from '../src/Modal';
import { Scene } from '@vectojs/core';

describe('Modal', () => {
  beforeEach(() => {
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type: string) {
      if (type === '2d') {
        return {
          font: '',
          fillStyle: '',
          measureText: () => ({ width: 100 }),
          fillText: () => {},
          scale: () => {},
          clearRect: () => {},
          save: () => {},
          restore: () => {},
          translate: () => {},
          rotate: () => {},
          beginPath: () => {},
          rect: () => {},
          clip: () => {},
          roundRect: () => {},
          fill: () => {},
        } as any;
      }
      return originalGetContext.apply(this, arguments as any);
    };
  });

  it('does not unmount immediately on close(); unmounts after the exit animation', async () => {
    const canvas = document.createElement('canvas');
    const scene = new Scene(canvas);
    const modal = new Modal('Test Header', { width: 300, height: 200 });

    scene.showOverlay(modal);
    expect(scene.overlayRoot.children.length).toBe(1);

    const closed = modal.close();
    // Still mounted immediately after close() — the exit animation must play first.
    expect(scene.overlayRoot.children.length).toBe(1);

    // The exit spring lives on the modal's card (the Scene ticks descendants each
    // frame); drive it to rest here in small steps, then let close()'s async
    // continuation run hideOverlay.
    const card = (modal as unknown as { card: { update(dt: number, t: number): void } }).card;
    for (let i = 0; i < 200; i++) card.update(16, i * 16);
    await closed;

    expect(scene.overlayRoot.children.length).toBe(0);
  });

  it('projects a modal dialog role for assistive tech', () => {
    const modal = new Modal('Prefs', { width: 300, height: 200 });
    const attrs = modal.getA11yAttributes();
    expect(attrs.role).toBe('dialog');
    expect(attrs.ariaModal).toBe('true');
    // Full-viewport backdrop is the focus-catching surface.
    expect((modal as unknown as { a11yFullViewport: boolean }).a11yFullViewport).toBe(true);
  });

  it('closes on Escape', async () => {
    const canvas = document.createElement('canvas');
    const scene = new Scene(canvas);
    const modal = new Modal('Esc me', { width: 300, height: 200 });
    scene.showOverlay(modal);
    expect(scene.overlayRoot.children.length).toBe(1);

    modal.emit('keydown', {
      nativeEvent: { key: 'Escape' },
      stopPropagation() {},
    });
    const card = (modal as unknown as { card: { update(dt: number, t: number): void } }).card;
    for (let i = 0; i < 200; i++) card.update(16, i * 16);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(scene.overlayRoot.children.length).toBe(0);
  });

  it('ignores non-Escape keys', () => {
    const canvas = document.createElement('canvas');
    const scene = new Scene(canvas);
    const modal = new Modal('Stay', { width: 300, height: 200 });
    scene.showOverlay(modal);
    modal.emit('keydown', { nativeEvent: { key: 'a' }, stopPropagation() {} });
    expect(scene.overlayRoot.children.length).toBe(1); // still open
  });
});
