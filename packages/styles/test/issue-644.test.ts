import { afterEach, describe, expect, it } from 'vitest';
import type { Entity } from '@vectojs/core';
import { applyStyle, setTheme, style, tokens, untrackVarStyles } from '../src/index';

type AnyEntity = Entity & Record<string, unknown>;

/** A stub whose `bg` writes are observable, so the test can see whether
 *  `setTheme` re-resolves a tracked style without inspecting internals. */
function countingStub(writes: string[]): AnyEntity {
  const e: any = { scene: null, constructor: { name: 'Stub' }, _bg: 'initial' };
  Object.defineProperty(e, 'bg', {
    get() {
      return e._bg;
    },
    set(v) {
      e._bg = v;
      writes.push(String(v));
    },
  });
  return e as AnyEntity;
}

/** Full-GC when the runtime exposes one (node --expose-gc / Bun.gc); the
 *  collection-dependent cases skip when none is available. */
const gc: (() => void) | undefined =
  (globalThis as unknown as { gc?: () => void }).gc ??
  (globalThis as unknown as { Bun?: { gc?: (sync?: boolean) => void } }).Bun?.gc?.bind(
    (globalThis as unknown as { Bun?: object }).Bun,
  );
const itWithGc = gc ? it : it.skip;

// Regression coverage for GH-644: theme var() tracking used
// WeakMap<Theme, Map<Entity, …>> — only the outer key was weak, so the inner
// map retained every styled entity strongly for the lifetime of the theme.
// Entity.destroy() has no hook back into styles, so destroyed entities stayed
// reachable and every setTheme re-resolved their styles forever. Entities are
// now held via WeakRef, dead entries are swept during setTheme's walk, and
// `untrackVarStyles` lets a framework release an entity eagerly on destroy.
const reset = tokens({ accent: '#000000' });

afterEach(() => {
  setTheme(reset);
});

describe('GH-644: theme var() tracking entity retention', () => {
  const themeA = tokens({ accent: '#111111' });
  const themeB = tokens({ accent: '#222222' });

  itWithGc('stops re-styling an entity once it is collected', async () => {
    setTheme(themeA);
    const writes: string[] = [];
    (() => {
      const e = countingStub(writes);
      applyStyle(e, style({ backgroundColor: 'var(--accent)' }));
    })();
    expect(writes).toEqual(['#111111']);

    // No destroy() hook exists — collection is the only release path. Force a
    // full GC; the tick between passes lets the collector finish promoting the
    // dropped young generation before the second sweep.
    gc!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc!();

    // Pre-fix the inner Map held the entity strongly, so setTheme still
    // resolved and wrote its style ('#222222' appended here).
    setTheme(themeB);
    expect(writes).toEqual(['#111111']);
  });

  it('keeps re-styling live entities across switches', () => {
    setTheme(themeA);
    const writes: string[] = [];
    const e = countingStub(writes);
    applyStyle(e, style({ backgroundColor: 'var(--accent)' }));
    setTheme(themeB);
    expect(writes).toEqual(['#111111', '#222222']);
  });

  it('untrackVarStyles releases an entity eagerly without waiting for GC', () => {
    setTheme(themeA);
    const writes: string[] = [];
    const e = countingStub(writes);
    applyStyle(e, style({ backgroundColor: 'var(--accent)' }));
    expect(writes).toEqual(['#111111']);

    untrackVarStyles(e);
    setTheme(themeB);
    expect(writes).toEqual(['#111111']);

    // Idempotent and safe for never-tracked entities.
    untrackVarStyles(e);
    untrackVarStyles(countingStub([]));
    setTheme(themeA);
    expect(writes).toEqual(['#111111']);
  });

  itWithGc('re-registers styling after a collected entity is swept', async () => {
    setTheme(themeA);
    const first: string[] = [];
    (() => {
      applyStyle(countingStub(first), style({ backgroundColor: 'var(--accent)' }));
    })();
    gc!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc!();
    setTheme(themeB);
    // A brand-new entity styled after the sweep must track normally.
    const second: string[] = [];
    const e = countingStub(second);
    applyStyle(e, style({ backgroundColor: 'var(--accent)' }));
    setTheme(reset);
    expect(second).toEqual(['#222222', '#000000']);
  });
});
