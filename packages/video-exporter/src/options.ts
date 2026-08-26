import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface ExportOptions {
  url: string;
  outputPath: string;
  width: number;
  height: number;
  fps?: number;
  duration?: number;
  /**
   * Optional audio file muxed into the export (encoded as AAC). The track is
   * trimmed to the video length (`-shortest`); the canvas pipeline itself
   * never produces sound, so exports stay silent unless this is provided.
   */
  audioPath?: string;
  signal?: AbortSignal;
}

export interface NormalizedExportOptions {
  url: string;
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  audioPath?: string;
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
  // H.264 yuv420p chroma is subsampled by 2, so odd dimensions can never
  // encode — but only ffmpeg knows that, and it says so at the very end of
  // the export with raw stderr, after every frame was rendered. Reject them
  // up front.
  if (options.width % 2 !== 0 || options.height % 2 !== 0) {
    throw new TypeError(
      `width and height must be even for H.264 (yuv420p) encoding (got ` +
        `${options.width}x${options.height})`,
    );
  }

  const isRemote = /^https?:\/\//i.test(options.url);
  const url = isRemote ? options.url : resolve(options.url);
  if (!isRemote) {
    if (!existsSync(url)) throw new Error(`Input file does not exist: ${url}`);
    if (!statSync(url).isFile()) throw new Error(`Input path is not a file: ${url}`);
  }

  // Fail on a bad audio input before Chromium launches, mirroring the input
  // file checks above: a missing track would otherwise only surface as raw
  // ffmpeg stderr at the very end of the export.
  let audioPath: string | undefined;
  if (options.audioPath !== undefined) {
    if (typeof options.audioPath !== 'string' || options.audioPath.trim() === '') {
      throw new TypeError('audioPath must be a non-empty string when provided');
    }
    audioPath = resolve(options.audioPath);
    if (!existsSync(audioPath)) throw new Error(`Audio file does not exist: ${audioPath}`);
    if (!statSync(audioPath).isFile()) throw new Error(`Audio path is not a file: ${audioPath}`);
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
    audioPath,
    signal: options.signal,
    isRemote,
    totalFrames: Math.ceil(fps * duration),
    dt: 1000 / fps,
  };
}
