// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { Scene } from '@vectojs/core';
import {
  Text,
  Button,
  Link,
  Image,
  Card,
  Stack,
  Input,
  Checkbox,
  Toggle,
  ScrollView,
} from '../src';

/**
 * Smoke / integration suite: compose every UI primitive into one Scene, run the
 * real render loop for several frames, and assert the accessibility/automation
 * shadow layer projects the right semantics — the cross-module path the
 * per-component unit tests don't cover (render loop + event propagation +
 * clip/scroll + a11y projection all at once).
 */

/** A no-op-everything 2D context (Proxy) so the render loop runs headless. */
function fakeCtx(): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        // Non-zero widths so text-only components (e.g. Link) get a real box and
        // therefore project an a11y node (the engine gates on width > 0).
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
  (scene as unknown as { isRunning: boolean }).isRunning = true; // let loop() run without scheduling
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) (scene as unknown as { loop: (t: number) => void }).loop(i * 16);
  };
  return { scene, root: host, tick };
}

/** Build a representative app using every primitive. */
function buildApp(): { tree: Stack; onClick: ReturnType<typeof vi.fn> } {
  const onClick = vi.fn();
  const col = new Stack({ direction: 'vertical', gap: 8 });
  col.add(new Text('Hello 世界', { maxWidth: 200 }));
  col.add(new Button('Go', { onClick }));
  col.add(new Link('Docs', { href: 'https://vectojs.org' }));
  col.add(new Checkbox({ label: 'Accept', checked: false }));
  col.add(new Toggle({ label: 'Dark', checked: true }));
  col.add(new Input({ width: 200, placeholder: 'Name' }));
  const card = new Card({ width: 220, height: 120, label: 'Profile' });
  card.add(new Image('avatar.png', { width: 48, height: 48, alt: 'Avatar' }));
  col.add(card);
  const sv = new ScrollView({ width: 220, height: 100 });
  sv.add(new Text('Long content\nmore lines\nand more', { maxWidth: 200 }));
  col.add(sv);
  return { tree: col, onClick };
}

describe('UI smoke / integration', () => {
  it('composes every primitive and renders multiple frames without throwing', () => {
    const { scene, tick } = makeScene();
    const { tree } = buildApp();
    scene.add(tree.setPosition(20, 20));

    expect(() => tick(5)).not.toThrow();
  });

  it('projects the accessibility/automation contract (roles, names, tags)', () => {
    const { scene, root, tick } = makeScene();
    const { tree } = buildApp();
    scene.add(tree.setPosition(20, 20));
    tick();

    // Native semantic elements project as real DOM (button / a / input).
    expect(root.querySelector('button')?.getAttribute('aria-label')).toBe('Go');
    expect(root.querySelector('a')?.getAttribute('href')).toBe('https://vectojs.org');
    expect(root.querySelector('img')?.getAttribute('alt')).toBe('Avatar');
    // Toggle is a role=switch; Checkbox is a real checkbox input.
    expect(root.querySelector('[role="switch"]')?.getAttribute('aria-label')).toBe('Dark');
    expect(root.querySelector('input[type="checkbox"]')).toBeTruthy();
    expect(root.querySelector('input[type="text"]')?.getAttribute('placeholder')).toBe('Name');
  });

  it('drives a button by its shadow node (event path end-to-end)', () => {
    const { scene, root, tick } = makeScene();
    const { tree, onClick } = buildApp();
    scene.add(tree.setPosition(20, 20));
    tick();

    const btn = root.querySelector('button')!;
    expect(btn).toBeTruthy();
    btn.dispatchEvent(new Event('click'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
