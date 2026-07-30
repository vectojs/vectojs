// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CodeBlock, Markdown, isMathJaxReady, preloadMathJax } from '../src/Markdown';
import { Image } from '@vectojs/ui';

/**
 * The lazy MathJax load, observed from the state a real page starts in.
 *
 * MathJax is dynamically imported, so `mathConverter` is null until something
 * asks for a formula. That module state is per-file (vitest isolates modules
 * between test files, verified by probe), which is the only reason this file can
 * see an unloaded MathJax while `streamingMath.test.ts` preloads in `beforeAll`.
 *
 * Consequence to keep in mind when adding tests here: ORDER MATTERS WITHIN THIS
 * FILE. Once any test triggers the load, MathJax stays loaded for the rest of the
 * file, so the "not loaded yet" assertions have to come first and cannot be
 * reordered without breaking their premise. `isMathJaxReady()` is asserted
 * explicitly wherever a test depends on which side of the load it is on, rather
 * than relying on position alone.
 */

const firstChild = (md: Markdown) => md.content.children[0] as any;
const mathImageOf = (md: Markdown): Image | null => {
  const container = firstChild(md);
  const inner = container?.children?.[0];
  return inner instanceof Image ? inner : null;
};

/** Let the dynamic import and its `.then` continuation run. */
const settleMathLoad = () => preloadMathJax();

afterEach(() => {
  vi.restoreAllMocks();
});

describe('lazy MathJax: a formula before the module resolves', () => {
  it('renders a closed fence as TeX source, then replaces it with the typeset image', async () => {
    // Precondition: this is the first test to touch math in this file.
    expect(isMathJaxReady()).toBe(false);

    const md = new Markdown('```math\n\\alpha_{lazy} + 1\n```');

    // Synchronously, the formula is honest TeX source rather than a blank box.
    const before = firstChild(md);
    expect(before).toBeInstanceOf(CodeBlock);
    expect(mathImageOf(md)).toBeNull();
    const sourceHeight = md.height;

    await settleMathLoad();
    await Promise.resolve();

    // Once the module lands the same document is typeset, without the caller
    // having re-rendered anything.
    expect(isMathJaxReady()).toBe(true);
    const img = mathImageOf(md);
    expect(img).not.toBeNull();
    expect(img!.src.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(img!.alt).toBe('\\alpha_{lazy} + 1');

    // The rebuild has to resync the document box, not just swap the entity:
    // `height` must track the typeset formula, or a consumer laying out siblings
    // below this block places them against the TeX source's box. Measured 60 ->
    // 66.832 for this formula under jsdom. This assertion only means anything
    // while MathJax is genuinely unloaded, which is why it lives in this test
    // rather than a later one — by then the load has happened and the document
    // would be typeset synchronously with no placeholder to grow from.
    expect(md.height).not.toBe(sourceHeight);
    expect(md.height).toBe(md.content.height);
  });

  it('typesets synchronously once the module is loaded', async () => {
    await settleMathLoad();
    expect(isMathJaxReady()).toBe(true);

    // No await between construction and assertion: after the one-time load every
    // later document is on the original synchronous path.
    const md = new Markdown('```math\n\\gamma_{sync}\n```');
    expect(mathImageOf(md)).not.toBeNull();
  });
});

describe('lazy MathJax: preloadMathJax', () => {
  it('is idempotent and shares one load across callers', async () => {
    const a = preloadMathJax();
    const b = preloadMathJax();
    // Same promise object, so N documents and N callers cannot start N loads.
    expect(a).toBe(b);
    await Promise.all([a, b]);
    expect(isMathJaxReady()).toBe(true);
  });

  it('makes the first formula synchronous when awaited before constructing', async () => {
    await preloadMathJax();
    const md = new Markdown('```math\n\\zeta_{preloaded}\n```');
    expect(mathImageOf(md)).not.toBeNull();
  });
});

describe('lazy MathJax: streaming prefetch', () => {
  it('starts loading while the fence is still open', async () => {
    const md = new Markdown('');
    const stream = md.createStream({});

    // An OPEN fence is not typeset, but it is the signal to begin fetching, so
    // the module is usually installed before the closing fence arrives. Without
    // the prefetch every streamed formula would pay a rebuild.
    stream.write('```math\n');
    stream.write('\\rho_{prefetch}');

    await settleMathLoad();
    expect(isMathJaxReady()).toBe(true);

    stream.write('\n```');
    await stream.close();
    expect(mathImageOf(md)).not.toBeNull();
  });

  it('leaves a non-math fence alone', async () => {
    const md = new Markdown('```ts\nconst x = 1;\n```');
    await settleMathLoad();
    await Promise.resolve();
    // A TypeScript fence must stay a CodeBlock; the rebuild is only for math.
    expect(firstChild(md)).toBeInstanceOf(CodeBlock);
    expect(mathImageOf(md)).toBeNull();
  });
});
