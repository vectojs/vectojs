import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { StagedOutput, type StagedOutputDependencies } from '../src/staged-output.js';

const scratchRoot = resolve(process.cwd(), '../../../tmp/video-exporter-tests');
let scratchDir = '';
let target = '';

beforeEach(async () => {
  await mkdir(scratchRoot, { recursive: true });
  scratchDir = await mkdtemp(join(scratchRoot, 'output-'));
  target = join(scratchDir, 'result.mp4');
});

afterEach(async () => {
  await rm(scratchDir, { recursive: true, force: true });
});

describe('StagedOutput', () => {
  it('creates unique MP4 staging paths beside the target', () => {
    const first = StagedOutput.create(target, { randomUUID: () => 'one' });
    const second = StagedOutput.create(target, { randomUUID: () => 'two' });

    expect(dirname(first.path)).toBe(scratchDir);
    expect(basename(first.path)).toBe('.result.vecto-one.mp4');
    expect(first.path).not.toBe(second.path);
  });

  it('atomically replaces an existing destination on success', async () => {
    await writeFile(target, 'old');
    const output = StagedOutput.create(target, { randomUUID: () => 'success' });
    await writeFile(output.path, 'new');

    await output.commit();
    await output.cleanup();

    expect(await readFile(target, 'utf8')).toBe('new');
    expect(await readdir(scratchDir)).toEqual(['result.mp4']);
  });

  it('removes a failed staged file without changing an existing destination', async () => {
    await writeFile(target, 'old');
    const output = StagedOutput.create(target, { randomUUID: () => 'failure' });
    await writeFile(output.path, 'partial');

    await output.cleanup();

    expect(await readFile(target, 'utf8')).toBe('old');
    expect(await readdir(scratchDir)).toEqual(['result.mp4']);
  });

  it('falls back through a backup when direct replacement reports EEXIST', async () => {
    await writeFile(target, 'old');
    const output = StagedOutput.create(target, {
      randomUUID: () => 'windows',
      rename: vi
        .fn<typeof rename>()
        .mockRejectedValueOnce(Object.assign(new Error('exists'), { code: 'EEXIST' }))
        .mockImplementation(rename),
    });
    await writeFile(output.path, 'new');

    await output.commit();
    await output.cleanup();

    expect(await readFile(target, 'utf8')).toBe('new');
    expect(await readdir(scratchDir)).toEqual(['result.mp4']);
  });

  it('restores the old destination when fallback installation fails', async () => {
    await writeFile(target, 'old');
    let call = 0;
    const injectedRename: typeof rename = async (from, to) => {
      call++;
      if (call === 1) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      if (call === 3) throw Object.assign(new Error('install failed'), { code: 'EIO' });
      await rename(from, to);
    };
    const output = StagedOutput.create(target, {
      randomUUID: () => 'restore',
      rename: injectedRename,
    });
    await writeFile(output.path, 'new');

    await expect(output.commit()).rejects.toThrow('install failed');
    await output.cleanup();

    expect(await readFile(target, 'utf8')).toBe('old');
    expect(await readdir(scratchDir)).toEqual(['result.mp4']);
  });

  it('cleans up idempotently', async () => {
    const output = StagedOutput.create(target, { randomUUID: () => 'twice' });
    await writeFile(output.path, 'partial');

    await output.cleanup();
    await output.cleanup();

    await expect(access(output.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('surfaces both install and restore failures', async () => {
    await writeFile(target, 'old');
    let call = 0;
    const dependencies: Partial<StagedOutputDependencies> = {
      randomUUID: () => 'aggregate',
      rename: async (from, to) => {
        call++;
        if (call === 1) throw Object.assign(new Error('exists'), { code: 'EPERM' });
        if (call === 2) return rename(from, to);
        if (call === 3) throw new Error('install failed');
        throw new Error('restore failed');
      },
    };
    const output = StagedOutput.create(target, dependencies);
    await writeFile(output.path, 'new');

    await expect(output.commit()).rejects.toMatchObject({
      errors: expect.arrayContaining([
        expect.objectContaining({ message: 'install failed' }),
        expect.objectContaining({ message: 'restore failed' }),
      ]),
    });
  });
});
