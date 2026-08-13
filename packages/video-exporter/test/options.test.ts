import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeOptions, type ExportOptions } from '../src/options.js';

// See staged-output.test.ts for why this is the OS temp dir rather than a
// cwd-relative path: the old `resolve(process.cwd(), '../../../tmp/…')` escaped the
// repository and left an empty parent directory behind on every run.
let scratchDir = '';
let localEntry = '';
let outputPath = '';

beforeEach(async () => {
  scratchDir = await mkdtemp(join(tmpdir(), 'vectojs-video-exporter-'));
  localEntry = join(scratchDir, 'scene.ts');
  outputPath = join(scratchDir, 'output.mp4');
  await writeFile(localEntry, 'export {};');
});

afterEach(async () => {
  await rm(scratchDir, { recursive: true, force: true });
});

function options(overrides: Partial<ExportOptions> = {}): ExportOptions {
  return {
    url: localEntry,
    outputPath,
    width: 1280,
    height: 720,
    ...overrides,
  };
}

describe('normalizeOptions', () => {
  it('applies the compatible defaults and resolves local paths', () => {
    expect(normalizeOptions(options())).toEqual(
      expect.objectContaining({
        url: localEntry,
        outputPath,
        width: 1280,
        height: 720,
        fps: 60,
        duration: 5,
        totalFrames: 300,
        dt: 1000 / 60,
        isRemote: false,
      }),
    );
  });

  it('keeps fractional API durations and rounds the effective frame count up', () => {
    expect(normalizeOptions(options({ fps: 24, duration: 0.1 }))).toEqual(
      expect.objectContaining({ duration: 0.1, totalFrames: 3, dt: 1000 / 24 }),
    );
  });

  it('accepts HTTP and HTTPS inputs without requiring a local file', () => {
    expect(normalizeOptions(options({ url: 'https://example.test/scene' }))).toEqual(
      expect.objectContaining({ url: 'https://example.test/scene', isRemote: true }),
    );
    expect(normalizeOptions(options({ url: 'http://localhost:4173' })).isRemote).toBe(true);
  });

  it.each([
    ['width', 0],
    ['width', 1.5],
    ['height', Number.NaN],
    ['height', Number.POSITIVE_INFINITY],
    ['fps', -1],
    ['fps', 23.976],
  ] as const)('rejects invalid %s values', (field, value) => {
    expect(() => normalizeOptions(options({ [field]: value }))).toThrow(
      new RegExp(`${field}.*positive.*integer`, 'i'),
    );
  });

  it.each([
    ['width', 1281],
    ['height', 719],
  ] as const)('rejects an odd %s before the encode instead of at the very end', (field, value) => {
    // H.264 yuv420p subsamples chroma by 2, so odd dimensions are only
    // rejected by ffmpeg after every frame was rendered and captured.
    expect(() => normalizeOptions(options({ [field]: value }))).toThrow(/even.*H\.264/i);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid duration %s',
    (duration) => {
      expect(() => normalizeOptions(options({ duration }))).toThrow(/duration.*positive.*finite/i);
    },
  );

  it('rejects a missing local entry', () => {
    expect(() => normalizeOptions(options({ url: join(scratchDir, 'missing.ts') }))).toThrow(
      /input.*does not exist/i,
    );
  });

  it('rejects an output whose parent directory does not exist', () => {
    expect(() =>
      normalizeOptions(options({ outputPath: join(scratchDir, 'missing', 'out.mp4') })),
    ).toThrow(/output directory.*does not exist/i);
  });
});
