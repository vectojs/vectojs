/**
 * URL sanitization helpers used by accessibility sinks (shadow `<a>` elements,
 * `window.open`, Markdown link renders, …) to prevent `javascript:` / `data:`
 * URI-script injection.
 *
 * The goal is conservative: allow safe browsing/navigation schemes, rewrite
 * everything else to a benign `#` placeholder so click handlers resolve without
 * executing payload or compromising the host DOM.
 */

/**
 * Schemes that are always safe for hyperlink navigation.
 *
 * - `http`, `https`, `mailto`, `tel`, `ftp` are universally supported navigational schemes.
 * - Relative URLs (`/path`, `./path`, `#anchor`, `?query`) and bare fragments
 *   pass through unchanged.
 *
 * Any other scheme — including `javascript:`, `data:`, `vbscript:`, `file:`,
 * custom protocol handlers — is stripped.
 */
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:', 'ftp:']);
const SCHEME_PATTERN = /^[a-z][a-z\d+.-]*$/i;

function normalizeSchemeCandidate(value: string): string {
  let result = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code > 0x20 && (code < 0x7f || code > 0x9f)) result += character;
  }
  return result;
}

function hasSafeSchemeOrIsRelative(url: string): boolean {
  const colonIndex = url.indexOf(':');
  if (colonIndex < 0) return true;

  const candidate = normalizeSchemeCandidate(url.slice(0, colonIndex));
  // A colon after a slash, query, or fragment is part of a relative URL.
  if (!SCHEME_PATTERN.test(candidate)) return true;
  return SAFE_SCHEMES.has(`${candidate.toLowerCase()}:`);
}

/**
 * Sanitize a potentially untrusted `href` / URL string for projection onto
 * an `<a>` element or a `window.open` call.
 *
 * Behaviour:
 * 1. Returns `''` for `null`/`undefined`/non-string input.
 * 2. Trims leading whitespace (browsers do this before scheme resolution).
 * 3. If the URL is relative (no scheme, or starts with `#`, `?`, `/`, `./`),
 *    returns it verbatim — relative navigation is never script-injectable.
 * 4. If the URL parses with a scheme NOT in {@link SAFE_SCHEMES}, returns `'#'`
 *    to keep the link non-empty but inert.
 * 5. Otherwise returns the trimmed input unchanged (no canonicalization).
 *
 * The function never throws; malformed input falls back to `'#'`.
 */
export function sanitizeUrl(href: string | null | undefined): string {
  if (typeof href !== 'string') return '';
  const trimmed = href.trim();
  if (trimmed === '') return '';

  return hasSafeSchemeOrIsRelative(trimmed) ? trimmed : '#';
}

/**
 * Narrower guard used by link renderers that already know they hold an
 * absolute URL: returns `true` if `urlStr` uses a scheme in
 * {@link SAFE_SCHEMES}, `false` otherwise. Relative URLs are considered safe.
 */
export function isSafeUrl(urlStr: string): boolean {
  if (typeof urlStr !== 'string') return false;
  const trimmed = urlStr.trim();
  if (trimmed === '') return false;
  return hasSafeSchemeOrIsRelative(trimmed);
}
