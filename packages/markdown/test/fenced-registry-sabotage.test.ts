// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Entity } from '@vectojs/core';
import { CodeBlock, Markdown } from '../src/Markdown';
import {
  ensureFencedBlockRenderer,
  registerFencedBlockRenderer,
  unregisterFencedBlockRenderer,
} from '../src/markdown-fenced-registry';

/**
 * Sabotage: prove the registry's gate is real, by removing it and watching the
 * fence fall back to a `CodeBlock`.
 *
 * These assertions go through a real `Markdown` instance rather than calling
 * `renderFencedBlock` directly, which is the whole point. The unit tests in
 * `fenced-registry.test.ts` only exercise fake renderers against the registry's
 * own functions, so they stayed green while the render arm was broken — an
 * earlier revision registered `code`/`math` as built-ins and shadowed their real
 * paths, failing 7 `streamingMath` tests that these tests never reached.
 *
 * Every case below therefore asserts on the entity a document actually produces.
 */

/** Every entity in the tree, document order. */
function walk(e: any, out: any[] = []): any[] {
  out.push(e);
  for (const c of e.children ?? []) walk(c, out);
  return out;
}

const codeBlocksOf = (md: Markdown): CodeBlock[] =>
  walk(md.content).filter((e) => e instanceof CodeBlock);

/**
 * A code block's source, read through its public content projection.
 *
 * `CodeBlock.source` is private, and reaching into it with `as any` would let a
 * rename break the fallback silently. The projection's `text` IS the source
 * (that is the contract selection and find-in-page rely on), so asserting on it
 * checks the fallback and the projection at once.
 */
const bodyOf = (block: CodeBlock): string | undefined => block.getContentProjection()?.text;

afterEach(() => {
  unregisterFencedBlockRenderer('sabotage');
});

describe('fenced-block registry sabotage', () => {
  it('renders a claimed language through its registered renderer', async () => {
    const marker = new Entity();
    registerFencedBlockRenderer('sabotage', {
      async load() {
        return () => marker;
      },
    });
    await ensureFencedBlockRenderer('sabotage');

    const md = new Markdown('```sabotage\nhello\n```\n');
    // The plugin's entity reached the tree, so the registry is wired into render.
    expect(walk(md.content)).toContain(marker);
    expect(codeBlocksOf(md)).toHaveLength(0);
  });

  it('falls back to a CodeBlock once that renderer is unregistered', async () => {
    const marker = new Entity();
    registerFencedBlockRenderer('sabotage', {
      async load() {
        return () => marker;
      },
    });
    await ensureFencedBlockRenderer('sabotage');
    unregisterFencedBlockRenderer('sabotage');

    const md = new Markdown('```sabotage\nhello\n```\n');
    // This is the gate: remove the renderer and the same source degrades to a
    // plain code block instead of throwing or rendering blank.
    expect(walk(md.content)).not.toContain(marker);
    expect(codeBlocksOf(md)).toHaveLength(1);
    expect(bodyOf(codeBlocksOf(md)[0])).toBe('hello');
  });

  it('falls back when a renderer is registered but its load has not resolved', () => {
    registerFencedBlockRenderer('sabotage', {
      async load() {
        return () => new Entity();
      },
    });
    // No `await ensureFencedBlockRenderer` — the renderer is registered but not
    // ready, which is exactly the first-fence-on-a-page case.
    const md = new Markdown('```sabotage\nhello\n```\n');
    expect(codeBlocksOf(md)).toHaveLength(1);
  });

  it('replaces the CodeBlock placeholder once the renderer load resolves', async () => {
    // A deferred load: the fence renders (as a CodeBlock) before the load is
    // resolved, then the resolution must swap the plugin entity in.
    let resolveLoad!: (r: () => Entity) => void;
    const marker = new Entity();
    registerFencedBlockRenderer('sabotage', {
      load: () =>
        new Promise<() => Entity>((resolve) => {
          resolveLoad = resolve;
        }),
    });

    const md = new Markdown('```sabotage\nhello\n```\n');
    expect(codeBlocksOf(md)).toHaveLength(1);

    resolveLoad(() => marker);
    // The renderer load promise is cached; awaiting it also drains the rebuild
    // continuation Markdown attached (registered before this await), so the
    // plugin entity is in the tree by the time this resolves.
    await ensureFencedBlockRenderer('sabotage');

    expect(walk(md.content)).toContain(marker);
    expect(codeBlocksOf(md)).toHaveLength(0);
  });

  it('falls back when the renderer returns null', async () => {
    registerFencedBlockRenderer('sabotage', {
      async load() {
        return () => null;
      },
    });
    await ensureFencedBlockRenderer('sabotage');

    const md = new Markdown('```sabotage\nhello\n```\n');
    expect(codeBlocksOf(md)).toHaveLength(1);
  });

  it('falls back when the renderer fails to load', async () => {
    registerFencedBlockRenderer('sabotage', {
      async load() {
        throw new Error('boom');
      },
    });
    await ensureFencedBlockRenderer('sabotage');

    const md = new Markdown('```sabotage\nhello\n```\n');
    expect(codeBlocksOf(md)).toHaveLength(1);
  });

  it('leaves an OPEN fence to the CodeBlock even with a ready renderer', async () => {
    const marker = new Entity();
    registerFencedBlockRenderer('sabotage', {
      async load() {
        return () => marker;
      },
    });
    await ensureFencedBlockRenderer('sabotage');

    // No closing fence: a half-arrived source must not be handed to a renderer as
    // if it were final, the same rule `rendersAsMath` enforces for math.
    const md = new Markdown('```sabotage\nhel');
    expect(walk(md.content)).not.toContain(marker);
    expect(codeBlocksOf(md)).toHaveLength(1);
  });

  it('never routes an unclaimed language through the registry', () => {
    const md = new Markdown('```unknown-lang\nsome code\n```\n');
    expect(codeBlocksOf(md)).toHaveLength(1);
    expect(bodyOf(codeBlocksOf(md)[0])).toBe('some code');
  });
});
