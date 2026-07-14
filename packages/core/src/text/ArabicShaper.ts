export interface ShapedResult {
  shapedText: string;
  indexMap: Int32Array;
}

interface GlyphForms {
  isolated: number;
  initial: number;
  medial: number;
  final: number;
  joining: 'D' | 'R' | 'U';
}

export class ArabicShaper {
  private static MAPPINGS: { [code: number]: GlyphForms } = {
    0x0621: { isolated: 0xfe80, initial: 0xfe80, medial: 0xfe80, final: 0xfe80, joining: 'U' }, // Hamza
    0x0622: { isolated: 0xfe81, initial: 0xfe81, medial: 0xfe82, final: 0xfe82, joining: 'R' }, // Alef Madda
    0x0623: { isolated: 0xfe83, initial: 0xfe83, medial: 0xfe84, final: 0xfe84, joining: 'R' }, // Alef Hamza Above
    0x0624: { isolated: 0xfe85, initial: 0xfe85, medial: 0xfe86, final: 0xfe86, joining: 'R' }, // Waw Hamza
    0x0625: { isolated: 0xfe87, initial: 0xfe87, medial: 0xfe88, final: 0xfe88, joining: 'R' }, // Alef Hamza Below
    0x0626: { isolated: 0xfe89, initial: 0xfe8b, medial: 0xfe8c, final: 0xfe8a, joining: 'D' }, // Yeh Hamza
    0x0627: { isolated: 0xfe8d, initial: 0xfe8d, medial: 0xfe8e, final: 0xfe8e, joining: 'R' }, // Alef
    0x0628: { isolated: 0xfe8f, initial: 0xfe91, medial: 0xfe92, final: 0xfe90, joining: 'D' }, // Ba
    0x0629: { isolated: 0xfe93, initial: 0xfe93, medial: 0xfe94, final: 0xfe94, joining: 'R' }, // Teh Marbuta
    0x062a: { isolated: 0xfe95, initial: 0xfe97, medial: 0xfe98, final: 0xfe96, joining: 'D' }, // Teh
    0x062b: { isolated: 0xfe99, initial: 0xfe9b, medial: 0xfe9c, final: 0xfe9a, joining: 'D' }, // Theh
    0x062c: { isolated: 0xfe9d, initial: 0xfe9f, medial: 0xfea0, final: 0xfe9e, joining: 'D' }, // Jeem
    0x062d: { isolated: 0xfea1, initial: 0xfea3, medial: 0xfea4, final: 0xfea2, joining: 'D' }, // Hah
    0x062e: { isolated: 0xfea5, initial: 0xfea7, medial: 0xfea8, final: 0xfea6, joining: 'D' }, // Khav
    0x062f: { isolated: 0xfea9, initial: 0xfea9, medial: 0xfeaa, final: 0xfeaa, joining: 'R' }, // Dal
    0x0630: { isolated: 0xfeab, initial: 0xfeab, medial: 0xfeac, final: 0xfeac, joining: 'R' }, // Thal
    0x0631: { isolated: 0xfead, initial: 0xfead, medial: 0xfeae, final: 0xfeae, joining: 'R' }, // Ra
    0x0632: { isolated: 0xfeaf, initial: 0xfeaf, medial: 0xfeb0, final: 0xfeb0, joining: 'R' }, // Zay
    0x0633: { isolated: 0xfeb1, initial: 0xfeb3, medial: 0xfeb4, final: 0xfeb2, joining: 'D' }, // Seen
    0x0634: { isolated: 0xfeb5, initial: 0xfeb7, medial: 0xfeb8, final: 0xfeb6, joining: 'D' }, // Sheen
    0x0635: { isolated: 0xfeb9, initial: 0xfebb, medial: 0xfebc, final: 0xfeba, joining: 'D' }, // Sad
    0x0636: { isolated: 0xfebd, initial: 0xfebf, medial: 0xfec0, final: 0xfebe, joining: 'D' }, // Dad
    0x0637: { isolated: 0xfec1, initial: 0xfec3, medial: 0xfec4, final: 0xfec2, joining: 'D' }, // Tah
    0x0638: { isolated: 0xfec5, initial: 0xfec7, medial: 0xfec8, final: 0xfec6, joining: 'D' }, // Zah
    0x0639: { isolated: 0xfec9, initial: 0xfecb, medial: 0xfecc, final: 0xfeca, joining: 'D' }, // Ain
    0x063a: { isolated: 0xfecd, initial: 0xfecf, medial: 0xfed0, final: 0xfece, joining: 'D' }, // Ghain
    0x0641: { isolated: 0xfed1, initial: 0xfed3, medial: 0xfed4, final: 0xfed2, joining: 'D' }, // Feh
    0x0642: { isolated: 0xfed5, initial: 0xfed7, medial: 0xfed8, final: 0xfed6, joining: 'D' }, // Qaf
    0x0643: { isolated: 0xfed9, initial: 0xfedb, medial: 0xfedc, final: 0xfeda, joining: 'D' }, // Kaf
    0x0644: { isolated: 0xfedd, initial: 0xfedf, medial: 0xfee0, final: 0xfede, joining: 'D' }, // Lam
    0x0645: { isolated: 0xfee1, initial: 0xfee3, medial: 0xfee4, final: 0xfee2, joining: 'D' }, // Meem
    0x0646: { isolated: 0xfee5, initial: 0xfee7, medial: 0xfee8, final: 0xfee6, joining: 'D' }, // Noon
    0x0647: { isolated: 0xfee9, initial: 0xfeeb, medial: 0xfeec, final: 0xfeea, joining: 'D' }, // Heh
    0x0648: { isolated: 0xfeed, initial: 0xfeed, medial: 0xfeee, final: 0xfeee, joining: 'R' }, // Waw
    0x0649: { isolated: 0xfeef, initial: 0xfeef, medial: 0xfef0, final: 0xfef0, joining: 'R' }, // Alef Maksura
    0x064a: { isolated: 0xfef1, initial: 0xfef3, medial: 0xfef4, final: 0xfef2, joining: 'D' }, // Yeh

    // Persian / Urdu Extensions
    0x067e: { isolated: 0xfb56, initial: 0xfb58, medial: 0xfb59, final: 0xfb57, joining: 'D' }, // Peh
    0x0686: { isolated: 0xfb7a, initial: 0xfb7c, medial: 0xfb7d, final: 0xfb7b, joining: 'D' }, // Tcheh
    0x06a9: { isolated: 0xfb8e, initial: 0xfb90, medial: 0xfb91, final: 0xfb8f, joining: 'D' }, // Keheh
    0x06c1: { isolated: 0xfba6, initial: 0xfba8, medial: 0xfba9, final: 0xfba7, joining: 'D' }, // Heh Goal
    0x06cc: { isolated: 0xfbfd, initial: 0xfbff, medial: 0xfc00, final: 0xfbfe, joining: 'D' }, // Farsi Yeh
  };

  private static isHarakat(code: number): boolean {
    return (code >= 0x064b && code <= 0x065f) || code === 0x0670;
  }

  private static getJoiningType(code: number): 'D' | 'R' | 'U' {
    const f = ArabicShaper.MAPPINGS[code];
    return f ? f.joining : 'U';
  }

  public static shapeArabic(text: string): ShapedResult {
    const len = text.length;
    const shapedChars: string[] = [];
    const sourceIndices: number[] = [];

    let i = 0;
    while (i < len) {
      const code = text.charCodeAt(i);

      // 1. Lam-Alef Ligature Preprocessing
      if (code === 0x0644 && i + 1 < len) {
        const nextCode = text.charCodeAt(i + 1);
        let ligature = 0;
        if (nextCode === 0x0622)
          ligature = 0xfef5; // Lam-Alef Madda
        else if (nextCode === 0x0623)
          ligature = 0xfef7; // Lam-Alef Hamza Above
        else if (nextCode === 0x0625)
          ligature = 0xfef9; // Lam-Alef Hamza Below
        else if (nextCode === 0x0627) ligature = 0xfefb; // Lam-Alef

        if (ligature !== 0) {
          let previousBase = 0;
          let previousIndex = i - 1;
          while (previousIndex >= 0) {
            const previousCode = text.charCodeAt(previousIndex);
            if (!ArabicShaper.isHarakat(previousCode)) {
              previousBase = previousCode;
              break;
            }
            previousIndex--;
          }
          if (ArabicShaper.getJoiningType(previousBase) === 'D') ligature++;
          shapedChars.push(String.fromCharCode(ligature));
          sourceIndices.push(i);
          i += 2;
          continue;
        }
      }

      // 2. Harakat are copied unchanged
      if (ArabicShaper.isHarakat(code)) {
        shapedChars.push(text[i]);
        sourceIndices.push(i);
        i++;
        continue;
      }

      const forms = ArabicShaper.MAPPINGS[code];
      if (!forms) {
        shapedChars.push(text[i]);
        sourceIndices.push(i);
        i++;
        continue;
      }

      // 3. Find adjacent base characters by skipping diacritics
      let prevCode = 0;
      let j = i - 1;
      while (j >= 0) {
        const c = text.charCodeAt(j);
        if (!ArabicShaper.isHarakat(c)) {
          prevCode = c;
          break;
        }
        j--;
      }

      let nextCode = 0;
      let k = i + 1;
      while (k < len) {
        const c = text.charCodeAt(k);
        if (!ArabicShaper.isHarakat(c)) {
          nextCode = c;
          break;
        }
        k++;
      }

      // 4. Connect Previous & Connect Next calculations
      const connectPrev =
        prevCode !== 0 &&
        ArabicShaper.getJoiningType(prevCode) === 'D' &&
        (forms.joining === 'D' || forms.joining === 'R');

      const connectNext =
        nextCode !== 0 &&
        forms.joining === 'D' &&
        (ArabicShaper.getJoiningType(nextCode) === 'D' ||
          ArabicShaper.getJoiningType(nextCode) === 'R');

      let glyph = forms.isolated;
      if (connectPrev && connectNext) glyph = forms.medial;
      else if (connectPrev) glyph = forms.final;
      else if (connectNext) glyph = forms.initial;

      shapedChars.push(String.fromCharCode(glyph));
      sourceIndices.push(i);
      i++;
    }

    return {
      shapedText: shapedChars.join(''),
      indexMap: new Int32Array(sourceIndices),
    };
  }
}
