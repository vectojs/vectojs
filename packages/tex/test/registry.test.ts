import { describe, expect, it } from 'vitest';
import type { HtmlBuilder } from '../src/registry/defineFunction';
import { setDuplicateRegistryWarnings } from '../src/registry/defineFunction';
import { _environments, default as defineEnvironment } from '../src/registry/defineEnvironment';

/**
 * The registry is one of two hand-written replacements for vendored upstream
 * files (`scripts/vendor-katex.ts` hashes the original into UPSTREAM.json).
 * Unlike a vendored file, nothing regenerates it, so its contract with the
 * builders around it is only as good as these tests: when a KaTeX bump adds
 * fields to an environment definition, they must reach `_environments` rather
 * than being silently dropped by a rebuilt literal.
 */
describe('defineEnvironment', () => {
  // A builder is required by the spec type but only consulted for the html
  // registry; these tests register under unique names and never build.
  const stubBuilder = (() => ({})) as unknown as HtmlBuilder<'array'>;

  const register = (names: string[], props: Record<string, unknown>) =>
    defineEnvironment({
      type: 'array',
      names,
      props: props as never,
      handler: () => {
        throw new Error('not reached');
      },
      htmlBuilder: stubBuilder,
    });

  it('applies the documented defaults when props carry none of them', () => {
    register(['__ctx0447-defaults'], { numArgs: 0 });
    const spec = _environments['__ctx0447-defaults'];

    expect(spec).toBeDefined();
    expect(spec.numArgs).toBe(0);
    expect(spec.allowedInText).toBe(false);
    expect(spec.numOptionalArgs).toBe(0);
    expect(spec.argTypes).toBeUndefined();
  });

  it('passes through argTypes, allowedInText and numOptionalArgs', () => {
    register(['__ctx0447-passthrough'], {
      numArgs: 1,
      argTypes: ['url'],
      allowedInText: true,
      numOptionalArgs: 2,
    });

    const spec = _environments['__ctx0447-passthrough'];
    expect(spec.numArgs).toBe(1);
    expect(spec.argTypes).toEqual(['url']);
    expect(spec.allowedInText).toBe(true);
    expect(spec.numOptionalArgs).toBe(2);
  });

  it('registers every name against the same spec object', () => {
    register(['__ctx0447-a', '__ctx0447-b'], { numArgs: 0 });
    expect(_environments['__ctx0447-a']).toBe(_environments['__ctx0447-b']);
  });

  it('warns on a duplicate registration only while the debug flag is on', () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg?: unknown) => {
      warnings.push(String(msg));
    };
    try {
      // Default: silent overwrite, as upstream KaTeX behaves.
      register(['__ctx0447-dup'], { numArgs: 0 });
      expect(warnings).toEqual([]);

      setDuplicateRegistryWarnings(true);
      register(['__ctx0447-dup'], { numArgs: 1 });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('duplicate environment registration');
      expect(warnings[0]).toContain('__ctx0447-dup');

      // The overwrite itself still happened.
      expect(_environments['__ctx0447-dup'].numArgs).toBe(1);
    } finally {
      setDuplicateRegistryWarnings(false);
      console.warn = originalWarn;
    }
  });
});
