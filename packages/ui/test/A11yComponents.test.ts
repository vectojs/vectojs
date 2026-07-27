// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Scene } from '@vectojs/core';
import { Slider, Dropdown, Button, Input, TextArea } from '../src';

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

  describe('disabled and validation state', () => {
    // The invariant: whatever the canvas draws as unavailable or failing must
    // project the same thing, or sighted and screen-reader users are told
    // opposite things. Neither Button nor Input could express these at all
    // before, despite A11yAttributes supporting them.
    it('Button projects disabled and blocks activation from both paths', () => {
      const { scene, root, tick } = makeScene();
      let clicks = 0;
      const button = new Button('Save', { disabled: true, onClick: () => clicks++ }).setPosition(
        0,
        0,
      );
      scene.add(button);
      tick();

      const el = root.querySelector('button')!;
      expect(el.hasAttribute('disabled')).toBe(true);

      // The DOM click is suppressed by the browser for a disabled button, but the
      // canvas hit-test dispatches independently — so the component must gate it
      // too, or a disabled button still fires when clicked on the canvas.
      button.emit('click', {} as never);
      expect(clicks).toBe(0);

      button.disabled = false;
      tick();
      expect(root.querySelector('button')!.hasAttribute('disabled')).toBe(false);
      button.emit('click', {} as never);
      expect(clicks).toBe(1);
    });

    it('Button omits the attribute when enabled rather than writing disabled=false', () => {
      const { scene, root, tick } = makeScene();
      scene.add(new Button('Go').setPosition(0, 0));
      tick();
      // `disabled="false"` on a native button still disables it, so emitting the
      // attribute unconditionally would be a functional bug, not just noise.
      expect(root.querySelector('button')!.hasAttribute('disabled')).toBe(false);
    });

    it('Input projects required and aria-invalid', () => {
      const { scene, root, tick } = makeScene();
      const field = new Input({
        width: 200,
        placeholder: 'Email',
        required: true,
        invalid: true,
      }).setPosition(0, 0);
      scene.add(field);
      tick();

      const el = root.querySelector('input')!;
      expect(el.hasAttribute('required')).toBe(true);
      expect(el.getAttribute('aria-invalid')).toBe('true');

      // Clearing invalid must remove the attribute, not set it to "false":
      // aria-invalid="false" means "explicitly valid", which is a different
      // statement from having no validation state.
      field.invalid = false;
      tick();
      expect(root.querySelector('input')!.hasAttribute('aria-invalid')).toBe(false);
    });

    it('TextArea projects required and aria-invalid', () => {
      const { scene, root, tick } = makeScene();
      const field = new TextArea({
        width: 200,
        height: 80,
        placeholder: 'Notes',
        required: true,
        invalid: true,
      }).setPosition(0, 0);
      scene.add(field);
      tick();

      const el = root.querySelector('textarea')!;
      expect(el.hasAttribute('required')).toBe(true);
      expect(el.getAttribute('aria-invalid')).toBe('true');
    });

    it('a field with no validation state projects neither attribute', () => {
      const { scene, root, tick } = makeScene();
      scene.add(new Input({ width: 200, placeholder: 'Name' }).setPosition(0, 0));
      tick();
      const el = root.querySelector('input')!;
      expect(el.hasAttribute('required')).toBe(false);
      expect(el.hasAttribute('aria-invalid')).toBe(false);
    });
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
    // NOT aria-valuenow: that attribute is numeric and only valid on range roles
    // (slider, spinbutton, progressbar, scrollbar, meter). Emitting it here made a
    // combobox report aria-valuenow="Banana", which axe flags as both a disallowed
    // attribute and an invalid value. A combobox's value is its accessible text.
    expect(comboboxEl.hasAttribute('aria-valuenow')).toBe(false);

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
    // Same reason as above: a combobox does not carry aria-valuenow. The
    // selection change is observable through the component's own value.
    expect(dropdown.selectedValue).toBe('Cherry');
    // change is observable through the component's own value.
    expect(dropdown.selectedValue).toBe('Cherry');
  });
});
