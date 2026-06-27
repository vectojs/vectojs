// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { Modal } from '../src/Modal';
import { Scene } from '@vecto-ui/core';

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

  it('does not unmount immediately on close() and plays exit animation', () => {
    const canvas = document.createElement('canvas');
    const scene = new Scene(canvas);
    const modal = new Modal('Test Header', { width: 300, height: 200 });

    scene.showOverlay(modal);
    expect(scene.overlayRoot.children.length).toBe(1);

    modal.close();
    // Verify still mounted immediately after close()
    expect(scene.overlayRoot.children.length).toBe(1);

    // Run updates to simulate convergence to scale 0
    // Spring physics update converts ms to seconds, so 5 seconds of dt (5000) will converge
    modal.update(5000, 5000);
    expect(scene.overlayRoot.children.length).toBe(0);
  });
});
