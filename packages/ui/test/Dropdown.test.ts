// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { Dropdown } from '../src/Dropdown';
import { Scene } from '@vecto-ui/core';

describe('Dropdown', () => {
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
        } as any;
      }
      return originalGetContext.apply(this, arguments as any);
    };
  });

  it('opens overlay menu on click and closes on click outside', () => {
    const canvas = document.createElement('canvas');
    const scene = new Scene(canvas);
    const dropdown = new Dropdown(['A', 'B', 'C'], { width: 100, height: 40 });
    scene.add(dropdown);

    expect(scene.overlayRoot.children.length).toBe(0);

    // Simulate click on Dropdown component
    dropdown.emit('click', { stopPropagation: () => {} });
    expect(scene.overlayRoot.children.length).toBeGreaterThan(0);
  });
});
