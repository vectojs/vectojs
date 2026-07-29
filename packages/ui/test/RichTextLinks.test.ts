// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { Scene, VectoJSEvent } from '@vectojs/core';
import { RichText } from '../src/RichText';

/**
 * Inline-link a11y / automation contract for {@link RichText} (Campaign 1 A.5).
 *
 * A link run inside flowing rich text must project a real, operable `<a href>`
 * shadow node — so a screen reader announces it and an automation agent
 * (Playwright / AI) can find it by href and click it, driving the same
 * `onLinkClick` a canvas click would. The hotspots are stable across re-wrap
 * (one per run) and pruned when the links go away, so the shadow layer never
 * leaks nodes.
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

describe('RichText inline-link a11y contract', () => {
  it('projects an <a href> shadow node for a link run', () => {
    const { scene, root, tick } = makeScene();
    scene.add(
      new RichText([
        { text: 'see ' },
        { text: 'the docs', style: { href: 'https://vecto.dev/docs' } },
      ]).setPosition(0, 0),
    );
    tick();

    const a = root.querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://vecto.dev/docs');
    // Real pointer input stays on the canvas for precise multi-line geometry;
    // AT/automation-synthesized clicks still activate the anchor.
    expect((a as HTMLElement).style.pointerEvents).toBe('none');
  });

  it('routes a shadow-node click to onLinkClick with the run href', () => {
    const onLinkClick = vi.fn();
    const { scene, root, tick } = makeScene();
    scene.add(
      new RichText([{ text: 'go ' }, { text: 'home', style: { href: '/home' } }], {
        onLinkClick,
      }).setPosition(0, 0),
    );
    tick();

    const a = root.querySelector('a')!;
    a.addEventListener('click', (e) => e.preventDefault()); // jsdom: don't attempt navigation
    a.dispatchEvent(new Event('click'));
    expect(onLinkClick).toHaveBeenCalledWith('/home');
  });

  it('projects one <a> per distinct link run', () => {
    const { scene, root, tick } = makeScene();
    scene.add(
      new RichText([
        { text: 'a', style: { href: '/x' } },
        { text: ' and ' },
        { text: 'b', style: { href: '/y' } },
      ]).setPosition(0, 0),
    );
    tick();

    const hrefs = [...root.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/x', '/y']);
  });

  it('keeps a single, stable <a> across a re-wrap (one hotspot per run)', () => {
    const { scene, root, tick } = makeScene();
    const rt = new RichText(
      [{ text: 'click ' }, { text: 'this long link label', style: { href: '/wrap' } }],
      { maxWidth: 1e9 },
    );
    scene.add(rt.setPosition(0, 0));
    tick();
    expect(root.querySelectorAll('a').length).toBe(1);

    rt.setMaxWidth(40); // force the link run to wrap across several lines
    tick();
    const links = root.querySelectorAll('a');
    expect(links.length).toBe(1);
    expect(links[0].getAttribute('href')).toBe('/wrap');
  });

  it('hits every visual line of a wrapped link without covering line-tail gaps', () => {
    const { scene, root, tick } = makeScene();
    const onLinkClick = vi.fn();
    const rt = new RichText([{ text: 'aaaa b', style: { href: '/wrap' } }], {
      maxWidth: 40,
      onLinkClick,
    }).setPosition(10, 20);
    scene.add(rt);
    tick();

    expect(root.querySelectorAll('a').length).toBe(1);
    const lastLineY = 20 + rt.height * 0.75;
    const laterLineHit = scene.findEntityAt(11, lastLineY);
    expect(laterLineHit).not.toBeNull();
    expect(laterLineHit).not.toBe(rt);
    laterLineHit!.dispatchEvent(new VectoJSEvent('click', laterLineHit!));
    expect(onLinkClick).toHaveBeenCalledOnce();

    const gapHit = scene.findEntityAt(10 + rt.width - 1, lastLineY);
    if (gapHit) gapHit.dispatchEvent(new VectoJSEvent('click', gapHit));
    expect(onLinkClick).toHaveBeenCalledOnce();
  });

  it('prunes the shadow <a> when the link run is removed (no leak)', () => {
    const { scene, root, tick } = makeScene();
    const rt = new RichText([{ text: 'x', style: { href: '/gone' } }]);
    scene.add(rt.setPosition(0, 0));
    tick();
    expect(root.querySelectorAll('a').length).toBe(1);

    rt.setSpans([{ text: 'plain now' }]);
    tick();
    expect(root.querySelectorAll('a').length).toBe(0);
  });
});
