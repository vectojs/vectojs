import { describe, expect, it } from 'vitest';
import { LayoutEngine } from '../src/LayoutEngine';
import type { GlyphAtlas } from '../src/LayoutEngine';

/** A minimal atlas: every listed char has a known advance at baseSize 10. */
function atlasFor(chars: string): GlyphAtlas {
  const atlas: GlyphAtlas = {};
  for (const ch of chars) atlas[ch] = { width: 5, baseSize: 10, ast: null };
  return atlas;
}

function engine(): LayoutEngine {
  return new LayoutEngine(1000, 1000);
}

describe('cacheStats', () => {
  it('starts with a null hit rate rather than a misleading zero', () => {
    const stats = engine().cacheStats();
    for (const name of ['word', 'grapheme', 'paragraph', 'richParagraph'] as const) {
      expect(stats[name].hits).toBe(0);
      expect(stats[name].misses).toBe(0);
      // null, not 0: "never consulted" and "consulted and always missed" are
      // different diagnoses and must not look the same.
      expect(stats[name].hitRate).toBeNull();
    }
  });

  it('counts a miss then a hit for a repeated paragraph', () => {
    const e = engine();
    const atlas = atlasFor('abcdefghijklmnopqrstuvwxyz ');
    e.prepare('hello world', atlas, 16);
    const first = e.cacheStats();
    expect(first.paragraph.misses).toBe(1);
    expect(first.paragraph.hits).toBe(0);

    e.prepare('hello world', atlas, 16);
    const second = e.cacheStats();
    expect(second.paragraph.hits).toBe(1);
    expect(second.paragraph.misses).toBe(1);
    expect(second.paragraph.hitRate).toBeCloseTo(0.5);
  });

  it('reports a zero hit rate when the key varies every call', () => {
    // The failure this exists to expose: a key that changes when it should not
    // makes the memo pure overhead, and the only symptom is being slow.
    const e = engine();
    const atlas = atlasFor('abcdefghijklmnopqrstuvwxyz 0123456789');
    for (let i = 0; i < 5; i++) e.prepare(`line ${i}`, atlas, 16);
    const stats = e.cacheStats();
    expect(stats.paragraph.misses).toBe(5);
    expect(stats.paragraph.hitRate).toBe(0);
  });

  it('reports size against capacity', () => {
    const e = engine();
    const atlas = atlasFor('abcdefghijklmnopqrstuvwxyz ');
    e.prepare('alpha', atlas, 16);
    const stats = e.cacheStats();
    expect(stats.paragraph.size).toBe(1);
    expect(stats.paragraph.capacity).toBe(1000);
    expect(stats.grapheme.capacity).toBe(2000);
    expect(stats.word.capacity).toBe(500);
  });

  it('counts an eviction as one full flush', () => {
    const e = engine();
    const atlas = atlasFor('abcdefghijklmnopqrstuvwxyz 0123456789');
    // Push past the 500-entry word cache cap.
    for (let i = 0; i < 520; i++) e.prepare(`w${i} x${i}`, atlas, 16);
    const stats = e.cacheStats();
    expect(stats.word.evictions).toBeGreaterThanOrEqual(1);
    // The cap is enforced, so size stays bounded well below the number of keys.
    expect(stats.word.size).toBeLessThanOrEqual(501);
  });

  it('resetCacheStats zeroes tallies but keeps the entries', () => {
    const e = engine();
    const atlas = atlasFor('abcdefghijklmnopqrstuvwxyz ');
    e.prepare('keep me', atlas, 16);
    const sizeBefore = e.cacheStats().paragraph.size;

    e.resetCacheStats();
    const stats = e.cacheStats();
    expect(stats.paragraph.hits).toBe(0);
    expect(stats.paragraph.misses).toBe(0);
    expect(stats.paragraph.size).toBe(sizeBefore);

    // Still cached: the next identical prepare is a hit, not a miss.
    e.prepare('keep me', atlas, 16);
    expect(e.cacheStats().paragraph.hits).toBe(1);
  });

  it('counts the rich cache separately from the plain one', () => {
    const e = engine();
    const atlas = atlasFor('abcdefghijklmnopqrstuvwxyz ');
    e.prepareRich([{ text: 'styled text' }], atlas, 16);
    e.prepareRich([{ text: 'styled text' }], atlas, 16);
    const stats = e.cacheStats();
    expect(stats.richParagraph.hits + stats.richParagraph.misses).toBeGreaterThan(0);
    expect(stats.paragraph.hits).toBe(0);
  });
});

describe('PreparedGlyph.atlasMiss', () => {
  it('flags the specific glyph the atlas lacked, not just the paragraph', () => {
    // 'z' is absent from the atlas, so its advance comes from the measurer.
    const e = engine();
    const prepared = e.prepare('az', atlasFor('a '), 16);
    const glyphs = prepared.paragraphs[0]!.words.flatMap((w) => w.glyphs);
    const byChar = new Map(glyphs.map((g) => [g.char, g]));

    expect(byChar.get('a')?.atlasMiss).toBeUndefined();
    expect(byChar.get('z')?.atlasMiss).toBe(true);
    // The paragraph flag still agrees, so the coarse signal is unchanged.
    expect(prepared.fallbackToCanvas).toBe(true);
  });

  it('omits the property entirely when every glyph is in the atlas', () => {
    const e = engine();
    const prepared = e.prepare('aaa', atlasFor('a '), 16);
    const glyphs = prepared.paragraphs[0]!.words.flatMap((w) => w.glyphs);
    expect(glyphs.length).toBeGreaterThan(0);
    for (const g of glyphs) expect('atlasMiss' in g).toBe(false);
    // The engine leaves the paragraph flag unset rather than writing `false`,
    // matching how it omits every other default-valued property.
    expect(prepared.fallbackToCanvas).toBeFalsy();
  });

  it('flags misses on the rich path too', () => {
    const e = engine();
    const prepared = e.prepareRich([{ text: 'aQ' }], atlasFor('a '), 16);
    const glyphs = prepared.paragraphs[0]!.words.flatMap((w) => w.glyphs);
    expect(glyphs.find((g) => g.char === 'Q')?.atlasMiss).toBe(true);
    expect(glyphs.find((g) => g.char === 'a')?.atlasMiss).toBeUndefined();
  });

  it('does not flag whitespace, which never needs a glyph', () => {
    const e = engine();
    const prepared = e.prepare('a a', atlasFor('a '), 16);
    const glyphs = prepared.paragraphs[0]!.words.flatMap((w) => w.glyphs);
    const space = glyphs.find((g) => g.char === ' ');
    // Whitespace is excluded from the fallback decision by the trim() guard, so
    // a missing space must not be reported as a fallback cause.
    if (space) expect(space.atlasMiss).toBeUndefined();
    expect(prepared.fallbackToCanvas).toBeFalsy();
  });
});
