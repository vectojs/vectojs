import { describe, it, expect, vi } from 'vitest';
import type { IRenderer } from '@vectojs/core';
import { Text } from '../src/Text';

/** Records every fillText call (Text draws one call per visual line). */
function recordingRenderer(): { r: IRenderer; lines: string[] } {
  const lines: string[] = [];
  const r = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'fillText') return (text: string) => lines.push(text);
        return () => {};
      },
    },
  ) as unknown as IRenderer;
  return { r, lines };
}

describe('Text streaming (流式打字机)', () => {
  it('append() grows the content and the accessible name', () => {
    const t = new Text('Hello');
    t.append(' world');
    expect(t.text).toBe('Hello world');
    expect(t.getA11yAttributes().label).toBe('Hello world');
  });

  it('append() across a newline yields two rendered lines', () => {
    const { r, lines } = recordingRenderer();
    const t = new Text('line1', { maxWidth: 1000 });
    t.append('\nline2');
    t.render(r);
    expect(lines).toEqual(['line1', 'line2']);
  });

  it('wakes an on-demand scene after a streamed append', () => {
    const t = new Text('first');
    const markDirty = vi.fn();
    (t as unknown as { _scene: { markDirty: () => void } })._scene = { markDirty };
    t.append(' second');
    expect(markDirty).toHaveBeenCalledOnce();
  });

  it('exposes its text for DOM content projection', () => {
    const t = new Text('Findable ui text', { font: '18px sans-serif' });
    const proj = t.getContentProjection()!;
    expect(proj.text).toBe('Findable ui text');
    expect(proj.font).toBe('18px sans-serif');
  });
});
