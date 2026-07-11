import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  exports?: Record<string, unknown>;
}

describe('package exports', () => {
  it('publishes Input through a lightweight subpath', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as PackageManifest;

    expect(manifest.exports?.['./input']).toEqual({
      types: './dist/Input.d.ts',
      import: './dist/Input.mjs',
      require: './dist/Input.js',
    });
  });
});
