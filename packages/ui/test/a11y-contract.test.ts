// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { Scene } from '@vecto-ui/core';
import { Button, Link, Image, Checkbox, Toggle, Input } from '../src';

/**
 * Accessibility / automation contract suite.
 *
 * VectoUI's differentiator is that every interactive entity projects a real,
 * operable DOM shadow node — so assistive tech AND automation agents
 * (Playwright, AI agents) can read its role/name/state and drive it by the same
 * affordances a user has (click, Enter/Space). This suite pins that contract:
 * the shadow layer exposes the right semantics, reflects live state every frame,
 * and round-trips clicks/keystrokes back into entity behavior.
 */

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

describe('a11y / automation contract', () => {
  it('projects the right role, name and tag for each interactive primitive', () => {
    const { scene, root, tick } = makeScene();
    scene.add(new Button('Save', { onClick() {} }).setPosition(0, 0));
    scene.add(new Link('Home', { href: '/home' }).setPosition(0, 20));
    scene.add(new Image('a.png', { width: 32, height: 32, alt: 'Avatar' }).setPosition(0, 40));
    scene.add(new Checkbox({ label: 'Accept', checked: false }).setPosition(0, 70));
    scene.add(new Toggle({ label: 'Dark', checked: false }).setPosition(0, 100));
    scene.add(new Input({ width: 180, placeholder: 'Email' }).setPosition(0, 130));
    tick();

    const btn = root.querySelector('button')!;
    expect(btn.getAttribute('aria-label')).toBe('Save');

    const link = root.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('/home');
    expect(link.getAttribute('aria-label')).toBe('Home');

    const img = root.querySelector('img')!;
    expect(img.getAttribute('alt')).toBe('Avatar');

    const cb = root.querySelector('input[type="checkbox"]')! as HTMLInputElement;
    expect(cb.getAttribute('aria-label')).toBe('Accept');

    const sw = root.querySelector('[role="switch"]')!;
    expect(sw.getAttribute('aria-label')).toBe('Dark');

    const input = root.querySelector('input[type="text"]')! as HTMLInputElement;
    expect(input.placeholder).toBe('Email');
  });

  it('exposes initial checked state (input.checked / aria-checked)', () => {
    const { scene, root, tick } = makeScene();
    scene.add(new Checkbox({ label: 'A', checked: true }).setPosition(0, 0));
    scene.add(new Toggle({ label: 'B', checked: true }).setPosition(0, 30));
    tick();

    expect((root.querySelector('input[type="checkbox"]')! as HTMLInputElement).checked).toBe(true);
    expect(root.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true');
  });

  it('drives a Checkbox by clicking its shadow node — state toggles, onChange fires, DOM reflects', () => {
    const onChange = vi.fn();
    const { scene, root, tick } = makeScene();
    scene.add(new Checkbox({ label: 'Accept', checked: false, onChange }).setPosition(0, 0));
    tick();

    const cb = root.querySelector('input[type="checkbox"]')! as HTMLInputElement;
    // click() runs the native activation (toggles `checked`, then fires
    // click/input/change) — the same path Playwright and AT drive a checkbox.
    cb.click();
    tick(); // next sync writes the settled state back onto the shadow node
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(cb.checked).toBe(true);

    cb.click();
    tick();
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(cb.checked).toBe(false);
  });

  it('drives a Toggle by clicking its shadow node — aria-checked flips, onChange fires', () => {
    const onChange = vi.fn();
    const { scene, root, tick } = makeScene();
    scene.add(new Toggle({ label: 'Dark', checked: false, onChange }).setPosition(0, 0));
    tick();

    const sw = root.querySelector('[role="switch"]')!;
    sw.dispatchEvent(new Event('click'));
    tick();
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });

  it('makes a non-native control keyboard-operable (role=switch is Tab-focusable + Enter activates)', () => {
    const onChange = vi.fn();
    const { scene, root, tick } = makeScene();
    scene.add(new Toggle({ label: 'Dark', checked: false, onChange }).setPosition(0, 0));
    tick();

    const sw = root.querySelector('[role="switch"]')!;
    // Non-native interactive role must be focusable for keyboard / AT.
    expect(sw.getAttribute('tabindex')).toBe('0');

    sw.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    tick();
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });

  it('drives a Button by clicking its shadow node; the native button needs no tabindex', () => {
    const onClick = vi.fn();
    const { scene, root, tick } = makeScene();
    scene.add(new Button('Go', { onClick }).setPosition(0, 0));
    tick();

    const btn = root.querySelector('button')!;
    // <button> is natively focusable — we must NOT add a redundant tabindex.
    expect(btn.hasAttribute('tabindex')).toBe(false);
    btn.dispatchEvent(new Event('click'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('projects entity geometry so an agent can locate the control spatially', () => {
    const { scene, root, tick } = makeScene();
    scene.add(new Button('Go', { onClick() {} }).setPosition(40, 80));
    tick();

    const btn = root.querySelector('button')! as HTMLElement;
    expect(btn.style.left).toBe('40px');
    expect(btn.style.top).toBe('80px');
    // pointer-events:auto keeps it clickable by Playwright/agents; opacity:0 hides chrome.
    expect(btn.style.pointerEvents).toBe('auto');
    expect(btn.style.opacity).toBe('0');
  });
});
