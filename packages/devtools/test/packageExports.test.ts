import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  exports?: Record<string, unknown>;
}

describe('package exports', () => {
  it('publishes headless inspection tools without the panel dependency graph', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as PackageManifest;

    expect(manifest.exports?.['./headless']).toEqual({
      types: './dist/headless.d.ts',
      import: './dist/headless.mjs',
      require: './dist/headless.js',
    });
  });
});
