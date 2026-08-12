/**
 * `ContentProjectionHint.textOnly` — the entity half of CTX-0204.
 *
 * A coarse-tier (resident, off-viewport) block needs only
 * `ContentProjection.text`: Scene writes it into one text node so find-in-page
 * and screen-reader read-ahead reach off-screen content, and never looks at
 * `lines`. Building them there is the O(glyphs) layout walk for a result that is
 * discarded on the same frame.
 *
 * These tests pin the entity contract directly — that `textOnly` suppresses the
 * walk and still returns the full text — rather than driving a `Scene`, because
 * `packages/core` cannot import `@vectojs/ui` (that is the dependency edge
 * backwards) and the interesting behaviour is the entity's own.
 */
import { describe, expect, it } from 'vitest';
import { RichText } from '../src/RichText';
import { Text } from '../src/Text';

/** Count `visualLineGroups` calls on ONE instance, leaving the prototype clean. */
function countLineWalks(rt: RichText): { calls: () => number; restore: () => void } {
  const target = rt as unknown as Record<string, unknown>;
  const proto = Object.getPrototypeOf(rt) as Record<string, unknown>;
  const original = proto.visualLineGroups as (...args: unknown[]) => unknown;
  let calls = 0;
  target.visualLineGroups = function (...args: unknown[]) {
    calls++;
    return original.apply(this, args);
  };
  return {
    calls: () => calls,
    restore: () => {
      delete target.visualLineGroups;
    },
  };
}

describe('ContentProjectionHint.textOnly', () => {
  it('RichText runs no line walk under textOnly, and still projects the whole text', () => {
    const source = 'hello world '.repeat(200);
    const rt = new RichText([{ text: source }], { maxWidth: 300 });

    const probe = countLineWalks(rt);
    const projection = rt.getContentProjection({ textOnly: true });
    const walks = probe.calls();
    probe.restore();

    // The point of the change: no layout for a projection Scene will discard.
    expect(walks).toBe(0);
    expect(projection?.lines).toBeUndefined();
    // Text is never narrowed — a missing character is invisible to find-in-page.
    expect(projection?.text).toBe(source);
    // Metrics the coarse tier still needs for its text node.
    expect(projection?.font).toBeTruthy();
    expect(projection?.lineHeight).toBeGreaterThan(0);
  });

  it('RichText still walks and returns lines without the hint', () => {
    const rt = new RichText([{ text: 'hello world '.repeat(20) }], { maxWidth: 300 });

    const probe = countLineWalks(rt);
    const projection = rt.getContentProjection();
    const walks = probe.calls();
    probe.restore();

    // Carriers need real geometry in the fine tier, so the walk must happen.
    expect(walks).toBeGreaterThan(0);
    expect(projection?.lines?.length).toBeGreaterThan(0);
  });

  it('Text returns text without lines under textOnly', () => {
    const source = 'alpha beta gamma delta '.repeat(30);
    const text = new Text(source, { maxWidth: 200 });

    const coarse = text.getContentProjection({ textOnly: true });
    expect(coarse?.lines).toBeUndefined();
    expect(coarse?.text).toBe(source);

    // Same instance, no hint: lines come back, so the hint is what gated them.
    const fine = text.getContentProjection();
    expect(fine?.lines?.length).toBeGreaterThan(0);
    expect(fine?.text).toBe(source);
  });
});
