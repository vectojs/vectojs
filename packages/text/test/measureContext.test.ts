// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createMeasuringContext,
  getSharedMeasuringContext,
  isSharedMeasuringContextAttached,
  resetSharedMeasuringContext,
} from '../src/measureContext';

/**
 * The engine measures text on one canvas and paints it on another. Gecko
 * resolves a generic CSS family (`serif`, `monospace`) through a per-language
 * font preference reachable only from a live document style context, so a canvas
 * outside any document resolves it to a different font than the attached canvas
 * being painted on.
 *
 * Measured on Firefox 153, `<html lang="zh">`, `measureText('MMMMMMMMMM')`:
 *
 * | font              | detached | attached | document layout |
 * | ----------------- | -------- | -------- | --------------- |
 * | `22px monospace`  | 109.737  | 131.579  | 132.000         |
 * | `22px serif`      | 109.737  | 205.526  | 206.333         |
 * | `22px sans-serif` | 177.895  | 177.895  | 178.667         |
 *
 * Detached `serif` and detached `monospace` return the *same* number — both
 * collapsed onto one fallback, 20% short on `monospace` and 47% on `serif`.
 * Chromium is unaffected, which is why this class of bug survives
 * Chromium-only testing.
 *
 * jsdom has no font engine, so these tests cannot assert widths; the numbers
 * above come from real browsers. What is pinned here is the structural invariant
 * the fix rests on — every measuring context is attached to the document —
 * because that is exactly the property a refactor drops silently.
 */
describe('measureContext', () => {
  beforeEach(() => {
    resetSharedMeasuringContext();
  });

  it('returns a context whose canvas is in the document', () => {
    const ctx = createMeasuringContext();
    expect(ctx).not.toBeNull();
    const canvas = ctx!.canvas as HTMLCanvasElement;
    expect(canvas.isConnected).toBe(true);
    expect(document.contains(canvas)).toBe(true);
  });

  it('keeps the measuring canvas out of layout and out of the a11y tree', () => {
    // It must not perturb the page it measures against, and must never be
    // announced: an implementation detail with no semantic content. `opacity: 0`
    // rather than `display: none` is deliberate — a `display: none` element is
    // outside layout and loses the style context this exists to acquire.
    const canvas = createMeasuringContext()!.canvas as HTMLCanvasElement;
    expect(canvas.style.position).toBe('absolute');
    expect(canvas.style.opacity).toBe('0');
    expect(canvas.style.display).not.toBe('none');
    expect(canvas.getAttribute('aria-hidden')).toBe('true');
    expect(canvas.width).toBe(1);
    expect(canvas.height).toBe(1);
  });

  it('attaches the shared context too, and reports it as attached', () => {
    const ctx = getSharedMeasuringContext();
    expect(ctx).not.toBeNull();
    expect((ctx!.canvas as HTMLCanvasElement).isConnected).toBe(true);
    expect(isSharedMeasuringContextAttached()).toBe(true);
  });

  it('memoizes the shared context rather than attaching one per call', () => {
    // The leak this guards: a caller that creates its own context per object
    // appends a permanent 1x1 canvas per object. In `@vectojs/ui` that reached
    // 205 canvases on a single 17 KB document, each holding a live 2D context —
    // invisible on the JS heap, but 277 MB of process memory.
    const first = getSharedMeasuringContext();
    const before = document.querySelectorAll('canvas').length;
    for (let i = 0; i < 25; i++) expect(getSharedMeasuringContext()).toBe(first);
    expect(document.querySelectorAll('canvas').length).toBe(before);
  });

  it('reset detaches the canvas and the next get builds a fresh attached one', () => {
    // The reason reset exists: attachment is best-effort, so a context created
    // before `document.body` existed is detached and silently measures generic
    // families wrong. A caller that detects it must be able to rebuild.
    const first = getSharedMeasuringContext();
    const firstCanvas = first!.canvas as HTMLCanvasElement;
    resetSharedMeasuringContext();
    expect(firstCanvas.isConnected).toBe(false);
    expect(isSharedMeasuringContextAttached()).toBe(false);

    const second = getSharedMeasuringContext();
    expect(second).not.toBe(first);
    expect((second!.canvas as HTMLCanvasElement).isConnected).toBe(true);
    expect(isSharedMeasuringContextAttached()).toBe(true);
  });

  it('reports not-attached before any context exists', () => {
    // `false` must mean "no attached shared context", not "no context yet" —
    // otherwise a caller cannot distinguish a detached context from a cold one.
    expect(isSharedMeasuringContextAttached()).toBe(false);
  });

  it('returns null without a DOM instead of throwing', () => {
    // SSR and worker portability: the whole package must stay importable and
    // callable with no `document`, falling back to registered metrics.
    const prev = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = undefined;
    try {
      expect(createMeasuringContext()).toBeNull();
      expect(getSharedMeasuringContext()).toBeNull();
    } finally {
      (globalThis as { document?: unknown }).document = prev;
    }
  });

  it('memoizes a DOM-free answer without retrying element creation', () => {
    // `undefined` vs `null` is load-bearing in the guard: a truthiness test
    // would retry `createElement` on every call in an SSR environment.
    const prev = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = undefined;
    try {
      expect(getSharedMeasuringContext()).toBeNull();
      expect(getSharedMeasuringContext()).toBeNull();
      expect(isSharedMeasuringContextAttached()).toBe(false);
    } finally {
      (globalThis as { document?: unknown }).document = prev;
    }
  });
});
