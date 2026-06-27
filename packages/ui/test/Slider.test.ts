// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Slider } from '../src/Slider';

describe('Slider', () => {
  it('computes fraction value correctly on pointermove', () => {
    const slider = new Slider({ min: 0, max: 100, value: 20, width: 200, height: 20 });
    expect(slider.value).toBe(20);

    // Mock getGlobalPosition because in jsdom it defaults to 0,0
    slider.getGlobalPosition = () => ({ x: 0, y: 0 });

    // Emit pointerdown and move to mid track (x=100)
    slider.emit('pointerdown', { clientX: 0 });
    slider.emit('pointermove', { clientX: 100 });
    expect(slider.value).toBe(50);
  });
});
