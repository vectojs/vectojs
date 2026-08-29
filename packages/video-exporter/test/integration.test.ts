import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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

/** Minimal 16-bit mono PCM WAV writer (8 kHz), enough for ffmpeg to mux. */
function toneWav(seconds: number, hz = 440, sampleRate = 8000): Buffer {
  const samples = Math.floor(seconds * sampleRate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / sampleRate) * 12000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

describe('real video export', () => {
  it(
    'renders exactly two H.264 frames through Chromium and FFmpeg',
    { retry: 2, timeout: 90_000 },
    async () => {
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
    },
  );

  it(
    'muxes an aac audio track when audioPath is provided',
    { retry: 2, timeout: 90_000 },
    async () => {
      const scratch = await mkdtemp(join(tmpdir(), 'vectojs-video-exporter-integration-'));
      scratchRoots.push(scratch);
      const outputPath = join(scratch, 'with-audio.mp4');
      const audioPath = join(scratch, 'tone.wav');
      await writeFile(audioPath, toneWav(0.5));

      await exportVideo({
        url: fixture,
        outputPath,
        width: 64,
        height: 64,
        fps: 2,
        duration: 1,
        audioPath,
      });

      const { stdout } = await execFileAsync('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_name,codec_type',
        '-of',
        'json',
        outputPath,
      ]);
      const result = JSON.parse(stdout) as {
        streams: Array<{ codec_name: string; codec_type: string }>;
      };

      expect(result.streams).toHaveLength(2);
      expect(result.streams[0]).toMatchObject({ codec_name: 'h264', codec_type: 'video' });
      expect(result.streams[1]).toMatchObject({ codec_name: 'aac', codec_type: 'audio' });
    },
  );
});
