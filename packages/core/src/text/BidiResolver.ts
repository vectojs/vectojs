export class BidiResolver {
  private static getDirectionClass(code: number): 'L' | 'R' | 'AL' | 'EN' | 'AN' | 'WS' | 'ON' {
    // Hebrew
    if ((code >= 0x0590 && code <= 0x05ff) || (code >= 0xfb1d && code <= 0xfb4f)) return 'R';
    // Arabic
    if (
      (code >= 0x0600 && code <= 0x06ff) ||
      (code >= 0x0750 && code <= 0x077f) ||
      (code >= 0x08a0 && code <= 0x08ff) ||
      (code >= 0xfb50 && code <= 0xfdff) ||
      (code >= 0xfe70 && code <= 0xfeff)
    ) {
      // Arabic punctuation
      if (code === 0x060c || code === 0x061b || code === 0x061f) return 'ON';
      return 'AL';
    }
    // ASCII digits
    if (code >= 0x30 && code <= 0x39) return 'EN';
    // Arabic digits
    if (code >= 0x0660 && code <= 0x0669) return 'AN';
    // Whitespace
    if (code === 0x20 || code === 0x09 || code === 0xa0) return 'WS';
    // General punctuation block
    if (code >= 0x2000 && code <= 0x206f) return 'ON';
    // ASCII Punctuation and symbols
    if (
      (code >= 0x21 && code <= 0x2f) ||
      (code >= 0x3a && code <= 0x40) ||
      (code >= 0x5b && code <= 0x60) ||
      (code >= 0x7b && code <= 0x7e)
    )
      return 'ON';

    return 'L';
  }

  public static resolveLevels(text: string): Uint8Array {
    const len = text.length;
    const classes: string[] = [];
    for (let i = 0; i < len; i++) {
      classes.push(BidiResolver.getDirectionClass(text.charCodeAt(i)));
    }

    // 1. Detect base level
    let baseLevel = 0;
    for (let i = 0; i < len; i++) {
      const c = classes[i];
      if (c === 'L') {
        baseLevel = 0;
        break;
      } else if (c === 'R' || c === 'AL') {
        baseLevel = 1;
        break;
      }
    }

    // 2. Dynamic embed stack resolver (up to 125 levels with overflow clamp)
    const levels = new Uint8Array(len);
    levels.fill(baseLevel);

    const stack: number[] = [baseLevel];
    let overflowCounter = 0;

    for (let i = 0; i < len; i++) {
      const charCode = text.charCodeAt(i);
      const isPushLRE = charCode === 0x202a;
      const isPushRLE = charCode === 0x202b;
      const isPopPDF = charCode === 0x202c;

      if (isPushLRE || isPushRLE) {
        const currentLevel = stack[stack.length - 1];
        const nextLevel = Math.min(
          125,
          isPushRLE ? (currentLevel + 1) | 1 : (currentLevel + 2) & ~1,
        );
        if (stack.length >= 125) {
          overflowCounter++;
        } else {
          stack.push(nextLevel);
        }
      } else if (isPopPDF) {
        if (overflowCounter > 0) {
          overflowCounter--;
        } else if (stack.length > 1) {
          stack.pop();
        }
      } else {
        const currentLevel = stack[stack.length - 1];
        const cls = classes[i];

        let val = currentLevel;
        if (cls === 'L') {
          val = currentLevel % 2 === 1 ? currentLevel + 1 : currentLevel;
        } else if (cls === 'R' || cls === 'AL') {
          val = currentLevel % 2 === 0 ? currentLevel + 1 : currentLevel;
        } else if (cls === 'EN' || cls === 'AN') {
          val = currentLevel % 2 === 1 ? currentLevel + 1 : currentLevel;
        }
        levels[i] = Math.min(125, val);
      }
    }

    return levels;
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
