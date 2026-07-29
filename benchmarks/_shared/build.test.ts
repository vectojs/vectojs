import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBenchmark } from './build';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tempRoot = join(repositoryRoot, 'tmp', 'benchmark-build-tests');

test('generated benchmark pages provide a dark readable surface', async () => {
  await mkdir(tempRoot, { recursive: true });
  const benchRoot = await mkdtemp(join(tempRoot, 'contrast-'));
  try {
    await Bun.write(join(benchRoot, 'entry.ts'), "document.body.textContent = 'fixture';\n");
    await buildBenchmark({ benchRoot, title: 'contrast fixture' });
    const html = await Bun.file(join(benchRoot, 'page', 'index.html')).text();

    expect(html).toContain('color-scheme: dark');
    expect(html).toContain('background: #0f172a');
    expect(html).toContain('color: #e2e8f0');
  } finally {
    await rm(benchRoot, { recursive: true, force: true });
  }
});
