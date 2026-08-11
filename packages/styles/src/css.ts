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
 */
export function css<T extends Style>(...styles: Array<T | null | undefined | false>): T {
  return Object.assign({}, ...styles.filter(Boolean)) as T;
}

/** Identity factory: types an object literal as {@link Style}, returns it unchanged. */
export function style<T extends Style>(s: T): T {
  return s;
}
