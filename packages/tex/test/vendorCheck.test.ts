import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  checkEmitConstants,
  extractUpstreamEmitConstants,
  flattenScss,
} from '../scripts/vendor-katex';

/**
 * The emit-constants drift guard (issue #611): `src/emit/` hand-transcribes
 * constants from katex.scss and Options.ts — files the vendoring script does
 * not copy — so nothing else notices when upstream moves one. These tests run
 * the guard against a synthetic checkout whose shapes mirror the real files.
 *
 * A positive case against the *real* reference clone runs too, when the clone
 * exists locally; it must stay skippable because CI has no `references/`.
 */

/** Minimal katex.scss holding every rule the guard reads, at current values. */
const CLEAN_SCSS = `
$mu: calc(1em / 18);

.katex {
    font: normal 1.21em KaTeX_Main, Times New Roman, serif;

    // Text font weights and shapes.
    .textbf {
        font-weight: bold;
    }
    .textit {
        font-style: italic;
    }
    // Text font families.
    .textrm {
        font-family: KaTeX_Main;
    }
    .textsf {
        font-family: KaTeX_SansSerif;
    }
    .texttt {
        font-family: KaTeX_Typewriter;
    }
    // Math fonts.
    .mathnormal {
        font-family: KaTeX_Math;
        font-style: italic;
    }
    .mathit {
        font-family: KaTeX_Main;
        font-style: italic;
    }
    .mathrm {
        font-style: normal;
    }
    .mathbf {
        font-family: KaTeX_Main;
        font-weight: bold;
    }
    .boldsymbol {
        font-family: KaTeX_Math;
        font-weight: bold;
        font-style: italic;
    }
    .amsrm {
        font-family: KaTeX_AMS;
    }
    .mathbb,
    .textbb {
        font-family: KaTeX_AMS;
    }
    .mathcal {
        font-family: KaTeX_Caligraphic;
    }
    .mathfrak,
    .textfrak {
        font-family: KaTeX_Fraktur;
    }
    .mathboldfrak,
    .textboldfrak {
        font-family: KaTeX_Fraktur;
        font-weight: bold;
    }
    .mathtt {
        font-family: KaTeX_Typewriter;
    }
    .mathscr,
    .textscr {
        font-family: KaTeX_Script;
    }
    .mathsf,
    .textsf {
        font-family: KaTeX_SansSerif;
    }
    .mathboldsf,
    .textboldsf {
        font-family: KaTeX_SansSerif;
        font-weight: bold;
    }
    .mathsfit,
    .mathitsf,
    .textitsf {
        font-family: KaTeX_SansSerif;
        font-style: italic;
    }
    .mainrm {
        font-family: KaTeX_Main;
        font-style: normal;
    }

    /* This value is also used in fontMetrics.js. */
    $ptperem: 10;
    $nulldelimiterspace: calc(1.2em / $ptperem);

    .vlist-t {
        display: inline-table;
        table-layout: fixed;
    }

    .mfrac {
        > span > span {
            text-align: center;
        }
    }

    .sqrt {
        > .katex-root {
            margin-left: calc(5*$mu);
            margin-right: calc(-10*$mu);
        }
    }

    .delimsizing {
        &.size1 { font-family: KaTeX_Size1; }
        &.size2 { font-family: KaTeX_Size2; }
        &.size3 { font-family: KaTeX_Size3; }
        &.size4 { font-family: KaTeX_Size4; }

        &.mult {
            .delim-size1 > span {
                font-family: KaTeX_Size1;
            }

            .delim-size4 > span {
                font-family: KaTeX_Size4;
            }
        }
    }

    .nulldelimiter {
        display: inline-block;
        width: $nulldelimiterspace;
    }

    .op-symbol {
        position: relative;

        &.small-op {
            font-family: KaTeX_Size1;
        }

        &.large-op {
            font-family: KaTeX_Size2;
        }
    }

    .op-limits {
        > .vlist-t {
            text-align: center;
        }
    }

    .katex-accent {
        > .vlist-t {
            text-align: center;
        }
    }

    .katex-sizing,
    .fontsize-ensurer {
        $sizes: 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.2, 1.44, 1.728, 2.074, 2.488;
    }

    .mtable {
        .col-align-c > .vlist-t {
            text-align: center;
        }

        .col-align-l > .vlist-t {
            text-align: left;
        }

        .col-align-r > .vlist-t {
            text-align: right;
        }
    }

    .svg-align {
        text-align: left;
    }

    .x-arrow,
    .mover,
    .munder {
        text-align: center;
    }
}
`;

const CLEAN_OPTIONS = `
// Mirrors src/Options.ts's multiplier table.
const sizeMultipliers = [
    0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.44, 1.728, 2.074, 2.488,
];
export default {};
`;

function makeSourceDir(mutate?: (scss: string) => string): string {
  const dir = mkdtempSync(join(tmpdir(), 'vendor-guard-test-'));
  // Same shape the guard expects from a real checkout: src/styles/katex.scss
  // beside src/Options.ts.
  mkdirSync(join(dir, 'styles'), { recursive: true });
  writeFileSync(join(dir, 'styles', 'katex.scss'), mutate ? mutate(CLEAN_SCSS) : CLEAN_SCSS);
  writeFileSync(join(dir, 'Options.ts'), CLEAN_OPTIONS);
  return dir;
}

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe('flattenScss', () => {
  it('resolves nesting, & and comma groups the way SCSS defines them', () => {
    const rules = flattenScss(`
.root {
    color: red;

    &.child {
        color: green;
    }

    .a, .b {
        margin: 0;

        > span {
            padding: 1px;
        }
    }

    /* comment } with braces */
    // line comment }
}
`);
    expect(rules).toEqual([
      { selector: '.root', decls: { color: 'red' } },
      { selector: '.root.child', decls: { color: 'green' } },
      { selector: '.root .a, .root .b', decls: { margin: '0' } },
      { selector: '.root .a > span, .root .b > span', decls: { padding: '1px' } },
    ]);
  });
});

describe('extractUpstreamEmitConstants', () => {
  const dir = makeSourceDir();
  scratch.push(dir);
  const extracted = extractUpstreamEmitConstants(dir);

  it('reads the scalar stylesheet variables', () => {
    expect(extracted.muDenominator).toBe(18);
    expect(extracted.nullDelimiterSpace).toBeCloseTo(0.12, 12);
    expect(extracted.scssSizes).toEqual([
      0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.2, 1.44, 1.728, 2.074, 2.488,
    ]);
    expect(extracted.optionsSizes).toEqual(extracted.scssSizes);
    expect(extracted.defaultFontFamily).toBe('Main');
  });

  it('derives the class-to-face tables from flattened rules', () => {
    expect(extracted.classFaces.mathnormal).toEqual({ family: 'Math', italic: true });
    expect(extracted.classFaces.textbf).toEqual({ family: null, bold: true });
    expect(extracted.classFaces.mathrm).toEqual({ family: null, italic: false });
    expect(extracted.delimSizeFonts).toEqual({
      size1: 'Size1-Regular',
      size2: 'Size2-Regular',
      size3: 'Size3-Regular',
      size4: 'Size4-Regular',
    });
    expect(extracted.directFontClasses).toEqual({
      'small-op': 'Size1-Regular',
      'large-op': 'Size2-Regular',
      'delim-size1': 'Size1-Regular',
      'delim-size4': 'Size4-Regular',
    });
  });

  it('records every text-align declaration for the checker to scope', () => {
    expect(extracted.alignRules).toEqual([
      { selector: '.katex .mfrac > span > span', align: 'center' },
      { selector: '.katex .op-limits > .vlist-t', align: 'center' },
      { selector: '.katex .katex-accent > .vlist-t', align: 'center' },
      { selector: '.katex .mtable .col-align-c > .vlist-t', align: 'center' },
      { selector: '.katex .mtable .col-align-l > .vlist-t', align: 'left' },
      { selector: '.katex .mtable .col-align-r > .vlist-t', align: 'right' },
      // Recorded even though cosmetic: the checker's direction-two scope
      // filter is what keeps this from reading as drift.
      { selector: '.katex .svg-align', align: 'left' },
      // Comma groups flatten to one resolved selector per group.
      { selector: '.katex .x-arrow', align: 'center' },
      { selector: '.katex .mover', align: 'center' },
      { selector: '.katex .munder', align: 'center' },
    ]);
  });
});

describe('checkEmitConstants', () => {
  it('accepts an upstream whose constants match the committed emit layer', () => {
    const dir = makeSourceDir();
    scratch.push(dir);
    expect(checkEmitConstants(dir)).toEqual([]);
  });

  const driftCases: [string, (scss: string) => string, RegExp][] = [
    ['mu', (s) => s.replace('calc(1em / 18)', 'calc(1em / 20)'), /\$mu.*MU/s],
    [
      'null delimiter space',
      (s) =>
        s.replace(
          '$nulldelimiterspace: calc(1.2em / $ptperem)',
          '$nulldelimiterspace: calc(1.5em / $ptperem)',
        ),
      /nulldelimiterspace/i,
    ],
    ['sizes', (s) => s.replace('0.7, 0.8', '0.75, 0.8'), /size/i],
    [
      'font class',
      (s) =>
        s.replace(
          '.mathbf {\n        font-family: KaTeX_Main;',
          '.mathbf {\n        font-family: KaTeX_Math;',
        ),
      /\.mathbf/,
    ],
    [
      'alignment',
      (s) =>
        s.replace(
          '.op-limits {\n        > .vlist-t {\n            text-align: center;',
          '.op-limits {\n        > .vlist-t {\n            text-align: right;',
        ),
      /op-limits/,
    ],
  ];

  for (const [label, mutate, pattern] of driftCases) {
    it(`fails when upstream ${label} drifts`, () => {
      const dir = makeSourceDir(mutate);
      scratch.push(dir);
      const messages = checkEmitConstants(dir);
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.join('\n')).toMatch(pattern);
    });
  }
});

/**
 * Positive control against the real pinned checkout — the exact input the
 * vendor run sees. Skipped where there is no `references/` clone (CI). Found
 * by walking up because a carryctx worktree sits deeper under the repo root
 * than a plain clone, so a fixed relative depth is wrong in one of the two.
 */
function findReferenceSrc(): string | undefined {
  let dir = import.meta.dirname;
  for (;;) {
    const candidate = join(dir, 'references/math/KaTeX/src');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const realSrc = findReferenceSrc();
describe.runIf(realSrc !== undefined)('checkEmitConstants against the pinned clone', () => {
  it('reports no drift at the vendored commit', () => {
    expect(checkEmitConstants(realSrc!)).toEqual([]);
  });
});
