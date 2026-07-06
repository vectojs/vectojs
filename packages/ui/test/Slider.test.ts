// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { Slider } from '../src/Slider';

describe('Slider', () => {
  it('computes fraction value correctly on pointermove', () => {
    const slider = new Slider({ min: 0, max: 100, value: 20, width: 200, height: 20 });
    expect(slider.value).toBe(20);

    // Emit pointerdown and move to mid track (x=100)
    slider.emit('pointerdown', { localX: 0 });
    slider.emit('pointermove', { localX: 100 });
    expect(slider.value).toBe(50);
  });

  it('marks on-demand scenes dirty when pointer input changes the value', () => {
    const markDirty = vi.fn();
    const onChange = vi.fn();
    const slider = new Slider({ min: 0, max: 100, value: 20, width: 200, height: 20, onChange });
    (slider as unknown as { _scene: unknown })._scene = { markDirty };

    slider.emit('pointerdown', { localX: 40 });
    slider.emit('pointermove', { localX: 100 });
    slider.emit('pointermove', { localX: 100 });

    expect(slider.value).toBe(50);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(markDirty).toHaveBeenCalledTimes(1);
  });
});
