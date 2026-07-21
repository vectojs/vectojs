import bidiFactory from 'bidi-js';

const bidi = bidiFactory();

export class BidiResolver {
  public static getBaseLevel(text: string): number {
    return bidi.getEmbeddingLevels(text).paragraphs[0]?.level ?? 0;
  }

  public static resolveLevels(text: string): Uint8Array {
    return bidi.getEmbeddingLevels(text).levels;
  }

  public static reorderVisual(nodes: any[], baseLevel: number): void {
    const len = nodes.length;
    if (len === 0) return;

    // 1. UAX #9 L1: Reset trailing whitespace and formatting controls to base level
    let i = len - 1;
    while (i >= 0) {
      const node = nodes[i];
      const code = node.char.charCodeAt(0);
      const isWS =
        code === 0x20 ||
        code === 0x09 ||
        code === 0xa0 ||
        code === 0x202a ||
        code === 0x202b ||
        code === 0x202c;
      if (isWS) {
        node.level = baseLevel;
      } else {
        break;
      }
      i--;
    }

    // 2. Find max level
    let maxLevel = baseLevel;
    for (let j = 0; j < len; j++) {
      if (nodes[j].level > maxLevel) maxLevel = nodes[j].level;
    }

    // 3. Reorder levels from max_level down to 1
    for (let level = maxLevel; level >= 1; level--) {
      let start = 0;
      while (start < len) {
        if (nodes[start].level >= level) {
          let end = start;
          while (end < len && nodes[end].level >= level) {
            end++;
          }
          // Reverse nodes in [start, end - 1]
          let left = start;
          let right = end - 1;
          while (left < right) {
            const temp = nodes[left];
            nodes[left] = nodes[right];
            nodes[right] = temp;
            left++;
            right--;
          }
          start = end;
        } else {
          start++;
        }
      }
    }
  }
}
