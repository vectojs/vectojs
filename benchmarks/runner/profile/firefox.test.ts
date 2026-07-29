import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { BrowserProfileOptions } from '../types';
import { firefoxRawProfilePath, prepareFirefoxProfile, startFirefoxProfile } from './firefox';

const tempRoot = resolve(import.meta.dir, '../../../tmp/firefox-profile-tests');

function options(tracePath: string): BrowserProfileOptions {
  return {
    profileDir: join(dirname(tracePath), 'profile'),
    targetUrl: 'http://127.0.0.1:8178/?runId=fixture-firefox-i1',
    tracePath,
    signal: new AbortController().signal,
  };
}

beforeAll(async () => {
  await mkdir(tempRoot, { recursive: true });
});

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe('Firefox Gecko profile artifacts', () => {
  test('prepares exact absolute output paths and removes only run-scoped stale files', async () => {
    const dir = await mkdtemp(join(tempRoot, 'prepare-'));
    const tracePath = join(dir, 'trace path', 'suite-firefox-i1.json.gz');
    const rawPath = firefoxRawProfilePath(tracePath);
    const unrelated = join(dirname(tracePath), 'other-run.json.gz');
    await mkdir(dirname(tracePath), { recursive: true });
    await Promise.all([
      writeFile(rawPath, 'stale raw'),
      writeFile(`${tracePath}.tmp`, 'stale gzip'),
      writeFile(tracePath, 'stale final'),
      writeFile(unrelated, 'keep'),
    ]);

    expect(await prepareFirefoxProfile(options(tracePath))).toEqual({
      MOZ_PROFILER_STARTUP: '1',
      MOZ_PROFILER_SHUTDOWN: rawPath,
    });
    expect(existsSync(rawPath)).toBeFalse();
    expect(existsSync(`${tracePath}.tmp`)).toBeFalse();
    expect(existsSync(tracePath)).toBeFalse();
    expect(await readFile(unrelated, 'utf8')).toBe('keep');
  });

  test('rejects relative and non-gzip trace paths before launch', async () => {
    await expect(prepareFirefoxProfile(options('relative/run.json.gz'))).rejects.toThrow(
      'must be an absolute path',
    );
    expect(() => firefoxRawProfilePath(resolve(tempRoot, 'run.json'))).toThrow(
      'must end in .json.gz',
    );
  });

  test('streams a stable raw profile to gzip atomically and removes the raw file', async () => {
    const dir = await mkdtemp(join(tempRoot, 'success-'));
    const tracePath = join(dir, 'suite-firefox-i1.json.gz');
    const rawPath = firefoxRawProfilePath(tracePath);
    const raw = '{"meta":{"product":"Firefox"},"threads":[]}\n';
    await prepareFirefoxProfile(options(tracePath));
    await writeFile(rawPath, raw);

    const session = await startFirefoxProfile(options(tracePath), { sleep: async () => {} });
    expect(session.stopAfterBrowserExit).toBeTrue();
    expect(session.shutdownGraceMs).toBe(60_000);
    await session.releaseBenchmark();
    const firstStop = session.stop();
    expect(session.stop()).toBe(firstStop);
    expect(await firstStop).toEqual({ tracePath, dataLossOccurred: false });
    expect(gunzipSync(await readFile(tracePath)).toString('utf8')).toBe(raw);
    expect(existsSync(rawPath)).toBeFalse();
    expect(existsSync(`${tracePath}.tmp`)).toBeFalse();
  });

  for (const fixture of [
    { name: 'missing', content: null },
    { name: 'empty', content: '' },
    { name: 'truncated', content: '{"threads":[' },
  ]) {
    test(`fails on ${fixture.name} raw output without publishing a gzip`, async () => {
      const dir = await mkdtemp(join(tempRoot, `${fixture.name}-`));
      const tracePath = join(dir, 'suite-firefox-i1.json.gz');
      const rawPath = firefoxRawProfilePath(tracePath);
      await prepareFirefoxProfile(options(tracePath));
      if (fixture.content !== null) await writeFile(rawPath, fixture.content);

      const session = await startFirefoxProfile(options(tracePath), { sleep: async () => {} });
      await expect(session.stop()).rejects.toThrow('Firefox profile finalization failed');
      expect(existsSync(tracePath)).toBeFalse();
      expect(existsSync(`${tracePath}.tmp`)).toBeFalse();
      expect(existsSync(rawPath)).toBe(fixture.content !== null);
    });
  }

  test('removes a partial gzip and retains valid raw JSON when compression fails', async () => {
    const dir = await mkdtemp(join(tempRoot, 'compression-'));
    const tracePath = join(dir, 'suite-firefox-i1.json.gz');
    const rawPath = firefoxRawProfilePath(tracePath);
    await prepareFirefoxProfile(options(tracePath));
    await writeFile(rawPath, '{"threads":[]}');

    const session = await startFirefoxProfile(options(tracePath), {
      sleep: async () => {},
      compress: async (_rawPath, temporaryPath) => {
        await writeFile(temporaryPath, 'partial');
        throw new Error('gzip failed');
      },
    });
    await expect(session.stop()).rejects.toThrow('Firefox profile finalization failed');
    expect(await readFile(rawPath, 'utf8')).toBe('{"threads":[]}');
    expect(existsSync(`${tracePath}.tmp`)).toBeFalse();
    expect(existsSync(tracePath)).toBeFalse();
  });
});
