// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Scene } from '@vectojs/core';
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

  it('projects an accessible name for Slider and Dropdown', () => {
    // A role with no accessible name is announced as bare "slider"/"combobox",
    // which says nothing about what the control does (WCAG 4.1.2). Both
    // components previously had no way to supply one — their visual labels are
    // drawn on canvas, so nothing reached the semantic layer. Found by driving
    // the a11y conformance fixture in a real browser and reading Chrome's
    // accessibility tree.
    const { scene, root, tick } = makeScene();
    const slider = new Slider({ min: 0, max: 100, value: 40, label: 'Volume' }).setPosition(0, 0);
    const dropdown = new Dropdown(['Small', 'Large'], { label: 'Size' }).setPosition(0, 60);
    scene.add(slider);
    scene.add(dropdown);
    tick();

    expect(root.querySelector('[role="slider"]')!.getAttribute('aria-label')).toBe('Volume');
    expect(root.querySelector('[role="combobox"]')!.getAttribute('aria-label')).toBe('Size');
  });

  it('omits aria-label when no name is supplied rather than inventing one', () => {
    // The fix must not fabricate a name from the value: "40" is not a label, and
    // a wrong name is worse than a missing one for a screen-reader user.
    const { scene, root, tick } = makeScene();
    scene.add(new Slider({ min: 0, max: 100, value: 40 }).setPosition(0, 0));
    tick();

    expect(root.querySelector('[role="slider"]')!.hasAttribute('aria-label')).toBe(false);
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
