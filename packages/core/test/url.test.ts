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

  it('handles empty and non-string values without throwing', () => {
    expect(sanitizeUrl('   ')).toBe('');
    expect(sanitizeUrl(null)).toBe('');
    expect(sanitizeUrl(undefined)).toBe('');
    expect(isSafeUrl('')).toBe(false);
    expect(isSafeUrl(null as unknown as string)).toBe(false);
  });
});
