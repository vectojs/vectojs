import type { Style } from './types';

/**
 * Merge style objects into one, later sources winning — the variant pattern:
 *
 * ```ts
 * const primary = css({ backgroundColor: '#2563eb', padding: 12 });
 * const muted = css(primary, { backgroundColor: 'var(--muted)' });
 * ```
 *
 * `null`/`undefined`/`false` sources are skipped, so variants can be
 * conditional. The result is a fresh plain object; it does not mutate inputs.
 * The one nested shape a `Style` can carry — a per-axis `padding` object — is
 * copied into the result, so mutating `merged.padding.x` never reaches back
 * into a source variant (GH-608).
 */
export function css<T extends Style>(...styles: Array<T | null | undefined | false>): T {
  const merged: Record<string, unknown> = {};
  for (const s of styles) {
    if (!s) continue;
    for (const [key, value] of Object.entries(s)) {
      merged[key] =
        key === 'padding' && typeof value === 'object' && value !== null
          ? { ...(value as object) }
          : value;
    }
  }
  return merged as T;
}

/** Identity factory: types an object literal as {@link Style}, returns it unchanged. */
export function style<T extends Style>(s: T): T {
  return s;
}
