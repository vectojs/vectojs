// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Markdown, isMathJaxReady } from '../src/Markdown';
import { Image } from '@vectojs/ui';

/**
 * `onStable` must not fire while a formula is still TeX source.
 *
 * This lives in its own file, and holds exactly ONE test, because it depends on
 * MathJax being unloaded. Module state is per-file but not per-test: the moment
 * any test triggers the lazy load the converter is installed for the rest of the
 * file, so a second test here could not observe the pre-load state and would
 * silently pass for the wrong reason. That is not a hypothetical — an earlier
 * draft had this test alongside the others and it passed while never once
 * exercising the settlement wait.
 */
describe('lazy MathJax settlement: onStable waits for typesetting', () => {
  it('hands onStable a typeset formula, not a CodeBlock of source', async () => {
    const md = new Markdown('');
    let stableSawImage: boolean | null = null;

    const stream = md.createStream({
      onStable: () => {
        // The whole contract of onStable: a caller doing expensive one-time work
        // here (measuring, exporting, laying out siblings) must see final boxes.
        const container = md.content.children[0] as any;
        stableSawImage = container?.children?.[0] instanceof Image;
      },
    });

    // The WHOLE fence in ONE chunk, with no await before close(). Written across
    // several chunks, the open-fence prefetch would finish during the gaps and
    // MathJax would already be loaded by close(), so the wait under test would
    // never happen. The assertion below pins that premise.
    stream.write('```math\n\\theta_{settle}\n```');
    expect(isMathJaxReady()).toBe(false);

    await stream.close();

    expect(stableSawImage).toBe(true);
  });
});
