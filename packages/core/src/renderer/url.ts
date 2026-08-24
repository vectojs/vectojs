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
 * Decode HTML character references so scheme detection sees the same text the
 * browser's URL parser will.
 *
 * The shadow `<a>` path assigns through `setAttribute`, whose value is NOT
 * entity-decoded, so a literal `javascript&#58;alert(1)` is inert there. But the
 * sanitized string is a public contract and can land in markup (SVGRenderer's
 * href, an app embedding hrefs into HTML), where the parser DOES decode — at
 * which point `javascript&#58;` becomes `javascript:` and executes. Decoding
 * before the scheme check closes that hole for every sink at once.
 *
 * Numeric references (`&#58;`, `&#x3a;`) cover every character, so the scheme
 * name itself can be entity-encoded; the named references below are the only
 * ones that affect scheme resolution (colon, and the control chars
 * `normalizeSchemeCandidate` strips). Named references never decode to plain
 * ASCII letters, so there is no third form to worry about. Decoded once, like
 * an HTML parser would; a double-encoded `&amp;colon;` stays decoded-once on
 * purpose — so does the parser's.
 *
 * The pre-check regex keeps the common no-reference path (an `&` in a query
 * string) to a single scan with no string allocations.
 */
const CHAR_REF = /&(?:#\d+|#x[\da-f]+|colon|tab|newline);/i;

const MAX_CODE_POINT = 0x10ffff;

/**
 * Decode one numeric character reference. Out-of-range values (beyond
 * U+10FFFF, or a digit run that overflows to `Infinity`) are parse errors in
 * HTML: browsers map them to U+FFFD rather than throwing, and so do we —
 * `String.fromCodePoint` would raise a RangeError and break the never-throws
 * contract documented on {@link sanitizeUrl}.
 */
function decodeCodePoint(value: number): string {
  return value <= MAX_CODE_POINT ? String.fromCodePoint(value) : '\u{FFFD}';
}

function decodeCharacterReferences(value: string): string {
  if (value.indexOf('&') < 0 || !CHAR_REF.test(value)) return value;
  return value
    .replace(/&#x([\da-f]+);/gi, (_, hex: string) => decodeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => decodeCodePoint(parseInt(dec, 10)))
    .replace(/&colon;/gi, ':')
    .replace(/&tab;/gi, '\t')
    .replace(/&newline;/gi, '\n');
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
 * 4. If the URL parses with a scheme NOT in {@link SAFE_SCHEMES} — after HTML
 *    character references are decoded, so an entity-encoded payload cannot
 *    smuggle a scheme past the check — returns `'#'` to keep the link non-empty
 *    but inert.
 * 5. Otherwise returns the trimmed input unchanged (no canonicalization).
 *
 * The function never throws; malformed input falls back to `'#'`.
 */
export function sanitizeUrl(href: string | null | undefined): string {
  if (typeof href !== 'string') return '';
  const trimmed = href.trim();
  if (trimmed === '') return '';

  // A decoded-safe URL is returned in its original (undecoded) form: any sink
  // will decode it to exactly the string that just passed the check.
  return hasSafeSchemeOrIsRelative(decodeCharacterReferences(trimmed)) ? trimmed : '#';
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
  return hasSafeSchemeOrIsRelative(decodeCharacterReferences(trimmed));
}
