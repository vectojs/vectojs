import { describe, expect, it } from 'vitest';
import { pickLabel, toGraphData, type KgGraphData } from '../src/types';

describe('pickLabel', () => {
  it('prefers the requested language, then neutral, then first value', () => {
    expect(pickLabel({ en: 'Hello', 'zh-cn': '你好' }, 'zh-cn')).toBe('你好');
    expect(pickLabel({ en: 'Hello' }, 'fr')).toBe('Hello');
    expect(pickLabel({ '': 'X', en: 'Hello' }, 'de')).toBe('X');
  });
});

describe('toGraphData', () => {
  it('passes entities/facts through as nodes/links', () => {
    const data: KgGraphData = {
      entities: [
        { id: 'a', type: 'Person', labels: { en: 'Ada' } },
        { id: 'b', type: 'Person', labels: { en: 'Bob' } },
      ],
      facts: [{ source: 'a', target: 'b', predicate: 'knows' }],
    };
    const g = toGraphData(data);
    expect(g.nodes).toHaveLength(2);
    expect(g.links).toHaveLength(1);
    expect(g.links[0]!.source).toBe('a');
  });
});
