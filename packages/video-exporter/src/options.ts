import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface ExportOptions {
  url: string;
  outputPath: string;
  width: number;
  height: number;
  fps?: number;
  duration?: number;
  signal?: AbortSignal;
}

export interface NormalizedExportOptions {
  url: string;
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  signal?: AbortSignal;
  isRemote: boolean;
  totalFrames: number;
  dt: number;
}

function positiveInteger(name: string, value: number): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite integer`);
  }
}

export function normalizeOptions(options: ExportOptions): NormalizedExportOptions {
  if (!options.url || typeof options.url !== 'string') {
    throw new TypeError('url must be a non-empty string');
  }
  if (!options.outputPath || typeof options.outputPath !== 'string') {
    throw new TypeError('outputPath must be a non-empty string');
  }

  const fps = options.fps ?? 60;
  const duration = options.duration ?? 5;

  positiveInteger('width', options.width);
  positiveInteger('height', options.height);
  positiveInteger('fps', fps);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new TypeError('duration must be a positive finite number');
  }

  const isRemote = /^https?:\/\//i.test(options.url);
  const url = isRemote ? options.url : resolve(options.url);
  if (!isRemote) {
    if (!existsSync(url)) throw new Error(`Input file does not exist: ${url}`);
    if (!statSync(url).isFile()) throw new Error(`Input path is not a file: ${url}`);
  }

  const outputPath = resolve(options.outputPath);
  const outputDirectory = dirname(outputPath);
  if (!existsSync(outputDirectory)) {
    throw new Error(`Output directory does not exist: ${outputDirectory}`);
  }
  if (!statSync(outputDirectory).isDirectory()) {
    throw new Error(`Output parent is not a directory: ${outputDirectory}`);
  }
  try {
    accessSync(outputDirectory, constants.W_OK);
  } catch {
    throw new Error(`Output directory is not writable: ${outputDirectory}`);
  }

  return {
    url,
    outputPath,
    width: options.width,
    height: options.height,
    fps,
    duration,
    signal: options.signal,
    isRemote,
    totalFrames: Math.ceil(fps * duration),
    dt: 1000 / fps,
  };
}
