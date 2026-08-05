import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { exportVideo } from '../src/index.js';

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(packageRoot, 'test/fixtures/two-frame-scene.ts');

const scratchRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    scratchRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('real video export', () => {
  it('renders exactly two H.264 frames through Chromium and FFmpeg', async () => {
    // The OS temp dir. This used to walk up from `process.cwd()` for an ancestor
    // holding both `vectojs/` and `tmp/`, i.e. it depended on the *workspace
    // container's* layout rather than on anything in this repository. It passed in CI
    // only by accident: GitHub checks out to `/home/runner/work/vectojs/vectojs`, so
    // the parent matched — and the `tmp/` that made it match was created by the two
    // sibling suites in this directory, which wrote outside the repo through the same
    // kind of cwd-relative path. Fixing those removed this test's accidental
    // dependency and it failed with "Could not find the VectoJS workspace", which is
    // how the coupling was found.
    const scratch = await mkdtemp(join(tmpdir(), 'vectojs-video-exporter-integration-'));
    scratchRoots.push(scratch);
    const outputPath = join(scratch, 'two-frames.mp4');

    await exportVideo({
      url: fixture,
      outputPath,
      width: 64,
      height: 64,
      fps: 2,
      duration: 1,
    });

    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-show_streams',
      '-show_entries',
      'stream=codec_name,width,height,nb_frames',
      '-of',
      'json',
      outputPath,
    ]);
    const result = JSON.parse(stdout) as {
      streams: Array<{ codec_name: string; width: number; height: number; nb_frames: string }>;
    };

    expect(result.streams).toEqual([
      expect.objectContaining({
        codec_name: 'h264',
        width: 64,
        height: 64,
        nb_frames: '2',
      }),
    ]);
    expect((await readdir(scratch)).filter((name) => name !== basename(outputPath))).toEqual([]);
  }, 90_000);
});
