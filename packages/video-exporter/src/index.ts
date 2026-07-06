import { ExportSession } from './export-session.js';
import { normalizeOptions, type ExportOptions } from './options.js';

export type { ExportOptions } from './options.js';

export async function exportVideo(options: ExportOptions): Promise<void> {
  const normalized = normalizeOptions(options);
  await new ExportSession(normalized).run();
}
