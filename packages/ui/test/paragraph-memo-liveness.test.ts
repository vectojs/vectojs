import { describe, expect, it } from 'vitest';
import type { LayoutEngine } from '@vectojs/core';
import { RichText } from '../src/RichText';
import { Text } from '../src/Text';

/**
 * The paragraph memo must actually be reached through the real components.
 *
 * `LayoutEngine.prepare`/`prepareRich` discard every memoized paragraph when the
 * atlas argument is not the same object as the previous call. Both components used
 * to pass a fresh `{}` literal per layout, so the memo was cleared every time and
 * never hit — measured 0 hits / 12 misses across five identical re-layouts, i.e.
 * dead code on the only paths that used it. These tests pin that it is live, and
 * they are the ones that would catch a regression back to a literal, since such a
 * regression changes no rendered output and no other test would notice.
 *
 * The engine is private, so it is read through a cast; `cacheStats()` itself is
 * public API.
 */
const engineOf = (component: RichText | Text): LayoutEngine =>
  (component as unknown as { engine: LayoutEngine }).engine;

describe('paragraph memo liveness', () => {
  it('RichText hits the rich-paragraph memo on a repeated layout', () => {
    // Two paragraphs, so this is the memoized path rather than the
    // single-paragraph streaming shape cache.
    const spans = [{ text: 'alpha beta gamma\ndelta epsilon zeta' }];
    const rt = new RichText(spans, { font: '16px sans-serif', maxWidth: 300 });
    const engine = engineOf(rt);
    const before = engine.cacheStats().richParagraph.hits;

    // Same content again: every paragraph should come from the memo.
    rt.setSpans([{ text: 'alpha beta gamma\ndelta epsilon zeta' }]);

    expect(engine.cacheStats().richParagraph.hits).toBeGreaterThan(before);
  });

  it('Text hits the paragraph memo on a repeated layout', () => {
    const t = new Text('alpha beta gamma\ndelta epsilon zeta', {
      font: '16px sans-serif',
      maxWidth: 300,
    });
    const engine = engineOf(t);
    const before = engine.cacheStats().paragraph.hits;

    t.setText('alpha beta gamma\ndelta epsilon zeta');

    expect(engine.cacheStats().paragraph.hits).toBeGreaterThan(before);
  });

  it('does not report evictions merely from re-laying out the same content', () => {
    // An eviction here would mean the atlas identity is still changing per call:
    // the clear path increments this counter.
    const rt = new RichText([{ text: 'one two\nthree four' }], {
      font: '16px sans-serif',
      maxWidth: 200,
    });
    const engine = engineOf(rt);
    for (let i = 0; i < 5; i++) rt.setSpans([{ text: 'one two\nthree four' }]);
    expect(engine.cacheStats().richParagraph.evictions).toBe(0);
  });

  it('still produces correct geometry with the memo live', () => {
    // Guards the obvious failure mode of caching: a hit that returns the wrong
    // paragraph. A re-laid-out RichText must match a freshly constructed one.
    const content = [{ text: 'wrapping text that is long enough to break\nsecond para' }];
    const reused = new RichText(content, {
      font: '16px sans-serif',
      maxWidth: 180,
    });
    reused.setSpans([{ text: 'wrapping text that is long enough to break\nsecond para' }]);
    const fresh = new RichText(
      [{ text: 'wrapping text that is long enough to break\nsecond para' }],
      {
        font: '16px sans-serif',
        maxWidth: 180,
      },
    );

    expect(reused.width).toBe(fresh.width);
    expect(reused.height).toBe(fresh.height);
  });
});
