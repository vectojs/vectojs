import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { normalizeOptions, type ExportOptions } from '../src/options.js';

const scratchRoot = resolve(process.cwd(), '../../../tmp/video-exporter-tests');
let scratchDir = '';
let localEntry = '';
let outputPath = '';

beforeEach(async () => {
  await mkdir(scratchRoot, { recursive: true });
  scratchDir = await mkdtemp(join(scratchRoot, 'options-'));
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
