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

  it('stops dragging on pointercancel so hover does not scrub the value (#678)', () => {
    const onChange = vi.fn();
    const slider = new Slider({ min: 0, max: 100, value: 20, width: 200, height: 20, onChange });

    slider.emit('pointerdown', { localX: 0 });
    slider.emit('pointermove', { localX: 100 });
    expect(slider.value).toBe(50);
    onChange.mockClear();

    slider.emit('pointercancel', {});

    slider.emit('pointermove', { localX: 150 });
    expect(slider.value).toBe(50);
    expect(onChange).not.toHaveBeenCalled();
  });

  function pressKey(slider: Slider, key: string) {
    slider.emit('keydown', {
      nativeEvent: { key },
      preventDefault: vi.fn(),
    });
  }

  it('arrow keys step the value and Home/End jump to the bounds', () => {
    const slider = new Slider({ min: 0, max: 100, value: 50 });

    pressKey(slider, 'ArrowRight');
    expect(slider.value).toBe(51);
    pressKey(slider, 'ArrowUp');
    expect(slider.value).toBe(52);
    pressKey(slider, 'ArrowLeft');
    pressKey(slider, 'ArrowDown');
    expect(slider.value).toBe(50);

    pressKey(slider, 'End');
    expect(slider.value).toBe(100);
    pressKey(slider, 'ArrowRight'); // clamped at max
    expect(slider.value).toBe(100);
    pressKey(slider, 'Home');
    expect(slider.value).toBe(0);
    pressKey(slider, 'ArrowLeft'); // clamped at min
    expect(slider.value).toBe(0);
  });

  it('honors a fractional step for keyboard and pointer input', () => {
    const slider = new Slider({ min: 0, max: 1, value: 0.5, step: 0.1, width: 200 });

    pressKey(slider, 'ArrowRight');
    expect(slider.value).toBeCloseTo(0.6);

    // Pointer at 3/4 of the track = raw 0.75 → snaps to nearest step 0.8
    slider.emit('pointerdown', { localX: 150 });
    expect(slider.value).toBeCloseTo(0.8);
  });

  it('emits change and marks the scene dirty on keyboard steps', () => {
    const markDirty = vi.fn();
    const onChange = vi.fn();
    const slider = new Slider({ min: 0, max: 10, value: 5, onChange });
    (slider as unknown as { _scene: unknown })._scene = { markDirty };

    pressKey(slider, 'ArrowRight');
    expect(onChange).toHaveBeenCalledWith(6);
    expect(markDirty).toHaveBeenCalledTimes(1);

    pressKey(slider, 'Home');
    expect(onChange).toHaveBeenCalledWith(0);
  });

  it('exposes the step through a11y attributes when set', () => {
    const slider = new Slider({ min: 0, max: 1, step: 0.25 });
    // role stays slider; keyboard support makes the role honest
    expect(slider.getA11yAttributes().role).toBe('slider');
  });

  it('clamps and snaps the initial value through the same path as mutations', () => {
    // value:250 used to store raw — thumb past the track, aria valuenow "250".
    expect(new Slider({ min: 0, max: 100, value: 250 }).value).toBe(100);
    // Off-step init used to render off-grid until first interaction.
    expect(new Slider({ min: 0, max: 100, value: 33, step: 10 }).value).toBe(30);
    expect(new Slider({ min: 0, max: 100, value: -5 }).value).toBe(0);
    expect(new Slider({}).value).toBe(0); // default min
  });

  it('rejects a non-positive/non-finite step and an inverted range at construction', () => {
    for (const bad of [0, -1, Number.NaN]) {
      expect(() => new Slider({ step: bad })).toThrow(/step must be/);
    }
    expect(() => new Slider({ min: 100, max: 0 })).toThrow(/max must be/);
  });

  it('projects disabled and ignores pointer + keyboard input while disabled', () => {
    const onChange = vi.fn();
    const slider = new Slider({ value: 50, onChange, disabled: true });
    expect(slider.disabled).toBe(true);
    // `undefined` when enabled so the projection drops the attribute entirely.
    expect(slider.getA11yAttributes().disabled).toBe(true);
    expect(new Slider({}).getA11yAttributes().disabled).toBeUndefined();

    slider.emit('pointerdown', { localX: 150 });
    slider.emit('pointermove', { localX: 150 });
    pressKey(slider, 'End');
    expect(slider.value).toBe(50);
    expect(onChange).not.toHaveBeenCalled();

    slider.disabled = false;
    pressKey(slider, 'End');
    expect(slider.value).toBe(100);
  });
});
