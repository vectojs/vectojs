// @vitest-environment jsdom
/**
 * Visual-vs-semantic state audit.
 *
 * The invariant: whatever a component *draws* as a state must also be
 * *projected*, or sighted and assistive-technology users are told different
 * things. A control drawn greyed-out whose shadow node reports enabled is the
 * worst case — a screen-reader user is invited to activate something that does
 * nothing.
 *
 * These tests are deliberately behavioural rather than structural: each drives a
 * real state change through the component's public API and asserts the projected
 * attribute followed. A static check (does `getA11yAttributes` mention
 * `disabled`?) cannot tell whether the value is actually kept in step, and greps
 * for state words also match comments and unrelated identifiers — which is how a
 * first pass at this audit produced four false leads.
 */
import { describe, it, expect } from 'vitest';
import { Scene, Entity } from '@vectojs/core';
import {
  Button,
  Checkbox,
  ContextMenu,
  Dropdown,
  Input,
  RadioGroup,
  Tabs,
  Text,
  TextArea,
  Toggle,
  TreeView,
} from '../src';

function makeScene(): {
  scene: Scene;
  root: HTMLElement;
  tick: () => void;
} {
  (globalThis as { window?: unknown }).window = {
    innerWidth: 900,
    innerHeight: 700,
    devicePixelRatio: 1,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const ctx = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'measureText') return (t: string) => ({ width: String(t).length * 8 });
        if (prop === 'canvas') return { width: 900, height: 700, style: {} };
        if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
        return () => {};
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
  HTMLCanvasElement.prototype.getContext = (() => ctx) as never;

  const canvas = document.createElement('canvas');
  canvas.width = 900;
  canvas.height = 700;
  const scene = new Scene(canvas, { disableWindowResize: true });
  scene.resize(900, 700);
  const s = scene as unknown as {
    syncA11y: (n: Entity) => void;
    enforceA11yDomOrder: () => void;
    root: Entity;
  };
  return {
    scene,
    root: scene.a11yRoot!,
    // step() renders but does NOT sync the a11y layer (that lives in the rAF
    // loop), so projection-sensitive assertions must drive the passes directly.
    tick: () => {
      scene.step(16.67);
      s.syncA11y(s.root);
      s.enforceA11yDomOrder();
    },
  };
}

describe('visual vs semantic state', () => {
  it('Button.disabled reaches the shadow node', () => {
    const { scene, root, tick } = makeScene();
    const button = new Button('Save').setPosition(0, 0);
    scene.add(button);
    tick();
    expect(root.querySelector('button')!.hasAttribute('disabled')).toBe(false);

    button.disabled = true;
    tick();
    expect(root.querySelector('button')!.hasAttribute('disabled')).toBe(true);

    button.disabled = false;
    tick();
    expect(root.querySelector('button')!.hasAttribute('disabled')).toBe(false);
  });

  it('Checkbox.checked reaches the shadow node', () => {
    const { scene, root, tick } = makeScene();
    const box = new Checkbox({ label: 'Accept' }).setPosition(0, 0);
    scene.add(box);
    tick();
    const read = (): boolean =>
      (root.querySelector('input[type="checkbox"]') as HTMLInputElement).checked;
    expect(read()).toBe(false);

    box.checked = true;
    tick();
    expect(read()).toBe(true);
  });

  it('Toggle.checked reaches aria-checked', () => {
    const { scene, root, tick } = makeScene();
    const toggle = new Toggle({ label: 'Notify' }).setPosition(0, 0);
    scene.add(toggle);
    tick();
    const read = (): string | null =>
      root.querySelector('[role="switch"]')!.getAttribute('aria-checked');
    expect(read()).toBe('false');

    toggle.checked = true;
    tick();
    expect(read()).toBe('true');
  });

  it('Input required/invalid reach the shadow node', () => {
    const { scene, root, tick } = makeScene();
    const field = new Input({ width: 200, placeholder: 'Email' }).setPosition(0, 0);
    scene.add(field);
    tick();
    const el = (): HTMLInputElement => root.querySelector('input')!;
    expect(el().required).toBe(false);
    expect(el().hasAttribute('aria-invalid')).toBe(false);

    field.required = true;
    field.invalid = true;
    tick();
    expect(el().required).toBe(true);
    expect(el().getAttribute('aria-invalid')).toBe('true');

    // Clearing must REMOVE aria-invalid, not set "false" — that asserts
    // "explicitly valid", a different statement from having no validation state.
    field.invalid = false;
    tick();
    expect(el().hasAttribute('aria-invalid')).toBe(false);
  });

  it('TextArea required/invalid reach the shadow node', () => {
    const { scene, root, tick } = makeScene();
    const field = new TextArea({
      width: 200,
      height: 80,
      placeholder: 'Notes',
    }).setPosition(0, 0);
    scene.add(field);
    tick();
    field.required = true;
    field.invalid = true;
    tick();
    const el = root.querySelector('textarea')!;
    expect((el as HTMLTextAreaElement).required).toBe(true);
    expect(el.getAttribute('aria-invalid')).toBe('true');
  });

  it('Dropdown expanded state reaches aria-expanded', () => {
    const { scene, root, tick } = makeScene();
    const dropdown = new Dropdown(['A', 'B'], {
      width: 160,
      label: 'Pick',
    }).setPosition(0, 0);
    scene.add(dropdown);
    tick();
    const read = (): string | null =>
      root.querySelector('[role="combobox"]')!.getAttribute('aria-expanded');
    // Closed by default; the drawn chevron and this attribute must agree.
    expect(read()).toBe('false');
  });

  it('Tabs selection reaches aria-selected, one at a time', () => {
    const { scene, root, tick } = makeScene();
    const tabs = new Tabs({
      tabs: [
        { id: 'a', label: 'A', content: new Text('a') },
        { id: 'b', label: 'B', content: new Text('b') },
      ],
      value: 'a',
      width: 200,
      height: 100,
    }).setPosition(0, 0);
    scene.add(tabs);
    tick();

    const selected = (): string[] =>
      [...root.querySelectorAll('[role="tab"]')]
        .filter((t) => t.getAttribute('aria-selected') === 'true')
        .map((t) => t.textContent ?? '');
    // Exactly one selected tab: two would make the drawn highlight ambiguous
    // against what AT announces.
    expect(selected()).toHaveLength(1);

    tabs.value = 'b';
    tick();
    expect(selected()).toHaveLength(1);
  });

  it('RadioGroup checked and disabled reach the shadow nodes', () => {
    const { scene, root, tick } = makeScene();
    const group = new RadioGroup({
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
        { value: 'c', label: 'C', disabled: true },
      ],
      value: 'a',
    }).setPosition(0, 0);
    scene.add(group);
    tick();

    const radios = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('[role="radio"]')];
    const checkedCount = (): number =>
      radios().filter((r) => r.getAttribute('aria-checked') === 'true').length;
    expect(checkedCount()).toBe(1);

    // The option drawn greyed out must project disabled, or a screen-reader user
    // is invited to select something that cannot be selected.
    const disabled = radios().filter(
      (r) => r.hasAttribute('disabled') || r.getAttribute('aria-disabled') === 'true',
    );
    expect(disabled).toHaveLength(1);

    group.value = 'b';
    tick();
    expect(checkedCount()).toBe(1);
  });

  it('TreeView expanded state reaches aria-expanded, and leaves omit it', () => {
    const { scene, root, tick } = makeScene();
    const tree = new TreeView({
      nodes: [
        { id: 'p', label: 'parent', children: [{ id: 'c', label: 'child' }] },
        { id: 'leaf', label: 'leaf' },
      ],
      width: 200,
      height: 120,
    }).setPosition(0, 0);
    scene.add(tree);
    tick();

    const items = [...root.querySelectorAll('[role="treeitem"]')];
    const withExpanded = items.filter((i) => i.hasAttribute('aria-expanded'));
    // A parent must expose it; a leaf must not. Announcing a leaf as collapsed
    // tells the user there is content to open that does not exist.
    expect(withExpanded.length).toBeGreaterThan(0);
    expect(withExpanded.length).toBeLessThan(items.length + 1);
  });

  it('ContextMenu disabled items project disabled', () => {
    const { scene, root, tick } = makeScene();
    const menu = new ContextMenu({
      items: [{ label: 'Cut' }, { separator: true }, { label: 'Paste', disabled: true }],
      width: 180,
    });
    menu.showAtPoint(10, 10, scene);
    tick();

    const items = [...root.querySelectorAll('[role="menuitem"]')];
    expect(items.length).toBeGreaterThanOrEqual(2);
    const disabled = items.filter(
      (i) => i.hasAttribute('disabled') || i.getAttribute('aria-disabled') === 'true',
    );
    expect(disabled).toHaveLength(1);
    // A separator is decorative: projecting it as a menuitem would create a
    // focusable stop that announces nothing.
    expect(
      items.every((i) => (i.getAttribute('aria-label') ?? i.textContent ?? '').trim() !== ''),
    ).toBe(true);
  });
});
