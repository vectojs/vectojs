// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Scene } from '@vecto-ui/core';
import { Slider, Dropdown } from '../src';

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

function makeScene(): { scene: Scene; root: HTMLElement; tick: (n?: number) => void } {
  const ctx = fakeCtx();
  HTMLCanvasElement.prototype.getContext = (() => ctx) as never;
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  host.appendChild(canvas);
  document.body.appendChild(host);
  const scene = new Scene(canvas);
  (scene as unknown as { isRunning: boolean }).isRunning = true;
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) (scene as unknown as { loop: (t: number) => void }).loop(i * 16);
  };
  return { scene, root: host, tick };
}

describe('UI component accessibility contract', () => {
  it('verifies Slider getA11yAttributes returns the correct WAI-ARIA values', () => {
    const { scene, root, tick } = makeScene();
    const slider = new Slider({ min: 10, max: 50, value: 30 }).setPosition(0, 0);
    scene.add(slider);
    tick();

    const sliderEl = root.querySelector('[role="slider"]')!;
    expect(sliderEl).not.toBeNull();
    expect(sliderEl.getAttribute('aria-valuenow')).toBe('30');
    expect(sliderEl.getAttribute('aria-valuemin')).toBe('10');
    expect(sliderEl.getAttribute('aria-valuemax')).toBe('50');
  });

  it('verifies Dropdown keyboard accessibility navigation and WAI-ARIA states', () => {
    const { scene, root, tick } = makeScene();
    const dropdown = new Dropdown(['Apple', 'Banana', 'Cherry'], { value: 'Banana' }).setPosition(
      0,
      0,
    );
    scene.add(dropdown);
    tick();

    // Combobox should represent state
    const comboboxEl = root.querySelector('[role="combobox"]')!;
    expect(comboboxEl).not.toBeNull();
    expect(comboboxEl.getAttribute('aria-expanded')).toBe('false');
    expect(comboboxEl.getAttribute('aria-valuenow')).toBe('Banana');

    // Simulate clicking to open the menu
    comboboxEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    tick();

    // Check dropdown menu overlays
    expect(comboboxEl.getAttribute('aria-expanded')).toBe('true');
    const listboxEl = root.querySelector('[role="listbox"]')!;
    expect(listboxEl).not.toBeNull();

    const options = root.querySelectorAll('[role="option"]');
    expect(options.length).toBe(3);
    expect(options[0].getAttribute('aria-label')).toBe('Apple');
    expect(options[1].getAttribute('aria-selected')).toBe('true');

    // Simulate keydown: ArrowDown to highlight Cherry
    comboboxEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    tick();

    // The activedescendant should point to Cherry option (index 2)
    const expectedId = `${dropdown.id}-opt-2`;
    expect(comboboxEl.getAttribute('aria-activedescendant')).toBe(expectedId);

    // Simulate Space key to select Cherry
    comboboxEl.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    tick();

    // Dropdown should close and selected value update to Cherry
    expect(comboboxEl.getAttribute('aria-expanded')).toBe('false');
    expect(comboboxEl.getAttribute('aria-valuenow')).toBe('Cherry');
  });
});
