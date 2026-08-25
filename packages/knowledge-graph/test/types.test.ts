import { describe, expect, it } from 'vitest';
import { pickLabel } from '../src/types';

describe('pickLabel', () => {
  it('prefers the requested language, then neutral, then first value', () => {
    expect(pickLabel({ en: 'Hello', 'zh-cn': '你好' }, 'zh-cn')).toBe('你好');
    expect(pickLabel({ en: 'Hello' }, 'fr')).toBe('Hello');
    expect(pickLabel({ '': 'X', en: 'Hello' }, 'de')).toBe('X');
  });
});
