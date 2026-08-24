import { describe, expect, it } from 'vitest';
import { isSafeUrl, sanitizeUrl } from '../src/renderer/url';

describe('URL policy', () => {
  it.each([
    'https://example.com/docs',
    'http://example.com',
    'mailto:team@example.com',
    'tel:+15551234567',
    'ftp://example.com/file.txt',
    '/docs/getting-started',
    './guide',
    '../reference',
    '#install',
    '?tab=api',
    'docs/intro',
  ])('preserves safe navigation URL %s', (url) => {
    expect(sanitizeUrl(url)).toBe(url);
    expect(isSafeUrl(url)).toBe(true);
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'java\nscript:alert(1)',
    'java\tscript:alert(1)',
    '\u0000javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'vbscript:msgbox(1)',
    'vecto-custom:payload',
  ])('rejects executable or non-navigation URL %j', (url) => {
    expect(sanitizeUrl(url)).toBe('#');
    expect(isSafeUrl(url)).toBe(false);
  });

  it.each([
    // Entity-encoded colon (numeric and named): an HTML attribute parser
    // decodes these, so a consumer embedding the sanitized string into markup
    // would resolve the scheme to javascript: unless the check decodes first.
    'javascript&#58;alert(1)',
    'javascript&#x3a;alert(1)',
    'javascript&colon;alert(1)',
    // Entity-encoded scheme letters hide the colon from the naive scan AND
    // break the scheme-name pattern, which read them as a relative URL.
    '&#106;avascript:alert(1)',
    'java&#115;cript:alert(1)',
    // Encoded control chars combined with a literal colon.
    'java&Tab;script:alert(1)',
    'java&NewLine;script:alert(1)',
    // Mixed-case and whitespace forms a parser still resolves.
    '  JaVaScRiPt&#58;alert(1)  ',
    'data&#x3a;text/html,<script>alert(1)</script>',
  ])('rejects entity-encoded executable schemes in %j', (url) => {
    expect(sanitizeUrl(url)).toBe('#');
    expect(isSafeUrl(url)).toBe(false);
  });

  it('passes safe URLs that merely contain character references', () => {
    // Decoding happens for the CHECK only; the caller's string is returned
    // verbatim when the decoded form is safe.
    expect(sanitizeUrl('https&#58;//example.com/docs')).toBe('https&#58;//example.com/docs');
    expect(isSafeUrl('https&#58;//example.com/docs')).toBe(true);
    // A query string full of ampersands is not a character reference.
    expect(sanitizeUrl('/search?q=a&b=1')).toBe('/search?q=a&b=1');
  });

  it('treats a double-encoded colon the way the parser does (decoded once)', () => {
    // &amp;colon; decodes to the LITERAL text `&colon;`, which is not a colon —
    // exactly what a browser's single decode pass produces, and therefore
    // still inert in any sink.
    expect(sanitizeUrl('javascript&amp;colon;alert(1)')).toBe('javascript&amp;colon;alert(1)');
  });

  it('maps out-of-range character references to U+FFFD without throwing', () => {
    // &#x110000; is beyond U+10FFFF: an HTML parser maps it to U+FFFD, while
    // String.fromCodePoint raises RangeError — which used to escape the
    // documented never-throws contract of sanitizeUrl/isSafeUrl.
    const hostile = '<a href="javascript&#x110000;&#1114112;alert(1)">x</a>';
    expect(() => sanitizeUrl(hostile)).not.toThrow();
    expect(() => isSafeUrl(hostile)).not.toThrow();
    // The decoded form holds replacement characters instead of a colon, so
    // the payload parses as relative and the input is returned verbatim.
    expect(sanitizeUrl('&#x110000;')).toBe('&#x110000;');
    expect(isSafeUrl('https&#58;//example.com/&#x10ffff;')).toBe(true);
    expect(sanitizeUrl('https&#58;//example.com/&#1114111;')).toBe(
      'https&#58;//example.com/&#1114111;',
    );
  });

  it('handles empty and non-string values without throwing', () => {
    expect(sanitizeUrl('   ')).toBe('');
    expect(sanitizeUrl(null)).toBe('');
    expect(sanitizeUrl(undefined)).toBe('');
    expect(isSafeUrl('')).toBe(false);
    expect(isSafeUrl(null as unknown as string)).toBe(false);
  });
});
