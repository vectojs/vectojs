export type { BrowserAdapter, BrowserLaunchSpec } from '../types';

export function firstExecutable(candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    const executable = Bun.which(candidate);
    if (executable) return executable;
  }
  return null;
}
