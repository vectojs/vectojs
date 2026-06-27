import { describe, it, expect } from 'vitest';
import { ArabicShaper } from '../src/text/ArabicShaper';

describe('ArabicShaper', () => {
  it('should shape Arabic text and compute monotonic indexMap', () => {
    // "كتب" (K-T-B) -> Isolated forms: ك (0x0643), ت (0x062A), ب (0x0628)
    // Shaped forms: Initial كـ (0xFEDF), Medial ـتـ (0xFE97), Final ـب (0xFE90)
    const raw = '\u0643\u062A\u0628';
    const res = ArabicShaper.shapeArabic(raw);

    expect(res.shapedText).toBe('\uFEDB\uFE98\uFE90');
    expect(res.indexMap.length).toBe(3);
    expect(res.indexMap[0]).toBe(0);
    expect(res.indexMap[1]).toBe(1);
    expect(res.indexMap[2]).toBe(2);
  });

  it('should skip Harakat diacritics and preserve connection', () => {
    // "كَتَبَ" (K + Fatha + T + Fatha + B + Fatha)
    const raw = '\u0643\u064E\u062A\u064E\u0628\u064E';
    const res = ArabicShaper.shapeArabic(raw);

    // Harakat (0x064E) should remain in place, base chars shaped
    expect(res.shapedText).toBe('\uFEDB\u064E\uFE98\u064E\uFE90\u064E');
  });

  it('should merge Lam-Alef ligatures with correct indexMap spans', () => {
    // "لا" (Lam 0x0644 + Alef 0x0627) -> Ligature لا (0xFEFB)
    const raw = '\u0644\u0627';
    const res = ArabicShaper.shapeArabic(raw);

    expect(res.shapedText).toBe('\uFEFB');
    expect(res.indexMap.length).toBe(1);
    expect(res.indexMap[0]).toBe(0); // maps back to Lam index 0
  });

  it('should support Persian Yeh and Keheh shaping forms', () => {
    // Keheh (0x06A9) + Farsi Yeh (0x06CC) -> "کی"
    // Shaped: Initial Keheh (0xFB90) + Final Farsi Yeh (0xFBFE)
    const raw = '\u06A9\u06CC';
    const res = ArabicShaper.shapeArabic(raw);

    expect(res.shapedText).toBe('\uFB90\uFBFE');
  });
});
