// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Markdown, isMathJaxReady } from '../src/Markdown';

/**
 * Destroying a document while its MathJax load is outstanding must not hang an
 * awaiting `close()`.
 *
 * One test, its own file, for the same reason as `lazyMathJaxSettlement.test.ts`:
 * the assertion is only meaningful against an unloaded MathJax, and the load is
 * per-file state that any earlier test would have already triggered.
 *
 * What it guards: a pending load holds settlement open (`waitForAppendSettled`
 * treats it as unsettled, and the flush guard refuses to release waiters while it
 * is set), while the load's own continuation returns early on a destroyed tree
 * without flushing. `destroy()` therefore has to clear the flag itself before it
 * flushes, or the waiter is never released and `close()` never settles.
 */
describe('lazy MathJax settlement: destroy during an outstanding load', () => {
  it('resolves close() instead of hanging', async () => {
    const md = new Markdown('');
    const stream = md.createStream({});

    // One chunk, so no prefetch gap can complete the load first.
    stream.write('```math\n\\xi_{destroyed}\n```');
    expect(isMathJaxReady()).toBe(false);

    const closed = stream.close();
    md.destroy();

    await expect(closed).resolves.toBeUndefined();
  });
});
