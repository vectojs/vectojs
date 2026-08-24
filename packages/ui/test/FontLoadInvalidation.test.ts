// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { notifyFontMetricsChanged } from '../src/measure';
import { Button } from '../src/Button';
import { Link } from '../src/Link';
import { Text } from '../src/Text';
import { Input } from '../src/Input';
import { TextArea } from '../src/TextArea';
import { RichText } from '../src/RichText';

/**
 * Webfont-load staleness (#681). Every component here measured once at
 * construction against whatever pixels were current, then cached per instance.
 * When a webfont finishes loading those pixels change, but nothing re-measured:
 * mis-centered labels, stale wrap breaks, drifting carets — until an unrelated
 * edit forced one. All six now subscribe to the shared
 * `notifyFontMetricsChanged` signal (wired to `document.fonts` in real
 * environments) and invalidate their own caches.
 *
 * jsdom has no `document.fonts` and no canvas measurement, so these tests drive
 * the exported signal directly and assert on cache invalidation / re-measure,
 * not on pixel values.
 */

const attachScene = (node: unknown) => {
  const markDirty = vi.fn();
  (node as { _scene: unknown })._scene = { markDirty };
  return markDirty;
};

describe('font-load invalidation across measuring components (#681)', () => {
  it('Button re-measures its intrinsic width when notified', () => {
    const button = new Button('OK');
    const markDirty = attachScene(button);
    // Simulate a stale pre-load measurement.
    button.textWidth = 1e6;
    button.width = 1e6 + button.padding * 2;

    notifyFontMetricsChanged();

    expect(button.textWidth).not.toBe(1e6);
    expect(button.width).toBe(button.textWidth + button.padding * 2);
    expect(markDirty).toHaveBeenCalled();
  });

  it('Link re-measures its width when notified', () => {
    const link = new Link('Docs', { href: 'https://example.com' });
    attachScene(link);
    link.width = 1e6;

    notifyFontMetricsChanged();

    expect(link.width).not.toBe(1e6);
    expect(link.width).toBeGreaterThan(0);
  });

  it('Text rebuilds its engine and prepared atlas when notified', () => {
    const text = new Text('hello world', { maxWidth: 200 });
    attachScene(text);
    const oldEngine = (text as unknown as { engine: unknown }).engine;
    const oldPrepared = (text as unknown as { prepared: unknown }).prepared;

    notifyFontMetricsChanged();

    const { engine, prepared } = text as unknown as { engine: unknown; prepared: unknown };
    expect(engine).not.toBe(oldEngine);
    expect(prepared).not.toBe(oldPrepared);
  });

  it('Input drops its keyed layout so the next getLayout rebuilds', () => {
    const input = new Input({ value: 'abc def' });
    attachScene(input);
    const getLayout = (input as unknown as { getLayout: () => unknown }).getLayout.bind(input);
    const first = getLayout();

    notifyFontMetricsChanged();
    const second = getLayout();

    expect(second).not.toBe(first);
  });

  it('TextArea drops its keyed wrap cache so the next computeLines rebuilds', () => {
    const ta = new TextArea({ value: 'line one\nline two' });
    attachScene(ta);
    const computeLines = (ta as unknown as { computeLines: () => unknown }).computeLines.bind(ta);
    const first = computeLines();

    notifyFontMetricsChanged();
    const second = computeLines();

    expect(second).not.toBe(first);
  });

  it('RichText rebuilds its engine and relayouts when notified', () => {
    const rt = new RichText([{ text: 'styled ' }], { maxWidth: 200 });
    attachScene(rt);
    const oldEngine = (rt as unknown as { engine: unknown }).engine;
    const oldResult = (rt as unknown as { result: unknown }).result;

    notifyFontMetricsChanged();

    const { engine, result } = rt as unknown as { engine: unknown; result: unknown };
    expect(engine).not.toBe(oldEngine);
    expect(result).not.toBe(oldResult);
  });

  it('subscriptions are torn down on destroy', () => {
    const button = new Button('OK');
    const markDirty = attachScene(button);
    button.destroy();

    notifyFontMetricsChanged();

    expect(markDirty).not.toHaveBeenCalled();
  });
});
