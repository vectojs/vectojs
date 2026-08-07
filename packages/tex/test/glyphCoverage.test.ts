import { describe, expect, it } from 'vitest';
import { DEFAULT_CORPUS } from '../scripts/subset-glyphs';
import { emitSVG } from '../src/emit/svg';
import { layout } from '../src/layout';

/**
 * Coverage of the **shipped** glyph table against the corpus it is subset from.
 *
 * These tests deliberately assert against `emitSVG`'s real output rather than
 * against `glyphs.subset.json`, because the encoded module
 * (`src/glyphs/glyphs.subset.ts`) is what actually ships and what `getGlyph`
 * reads. `glyphs.json` — the full table — is a gitignored build artifact, so a
 * test that needed it could not run on a fresh clone or in CI.
 *
 * The invariant is one sentence: **every formula in the corpus must typeset with
 * no missing glyph, in both display modes.** `EmitResult.missing` is the only
 * signal for that, and it must be checked rather than `placements`: a missing
 * glyph emits *no* placement, so a placement-only probe reports that display
 * mode demands nothing new and the gap stays invisible. That is exactly how the
 * whole corpus came to be subset in inline mode alone.
 */
describe('shipped glyph table covers the subset corpus', () => {
  for (const displayMode of [false, true]) {
    const label = displayMode ? 'display' : 'inline';

    it(`typesets every corpus formula in ${label} mode with no missing glyph`, () => {
      const gaps: { tex: string; missing: string[] }[] = [];

      for (const tex of DEFAULT_CORPUS) {
        const result = emitSVG(layout(tex, { displayMode }));
        if (result.missing.length > 0) {
          gaps.push({ tex, missing: result.missing });
        }
      }

      // Reported as a list so a regression names the formula and the face, not
      // just a count. `Size2-Regular/U+2211  <- $$\sum$$` is actionable; "8
      // missing" sends the next reader back to a probe script.
      expect(gaps).toEqual([]);
    });
  }

  // Display mode selects larger delimiters and big operators than inline mode
  // ever requests, which is the specific reason both modes must be subset. This
  // pins the face whose absence was the original defect: `Size1` and `Size3`
  // were both shipped while `Size2` was not, which is what made the hole hard
  // to notice.
  it('ships the Size2-Regular face that display-mode big operators need', () => {
    const bigOperators = ['\\sum_{i=1}^{n} i', '\\int_0^1 x\\,dx', '\\prod_{i=1}^{n} i'];
    const faces = new Set<string>();

    for (const tex of bigOperators) {
      const result = emitSVG(layout(tex, { displayMode: true }));
      expect(result.missing).toEqual([]);
      for (const p of result.placements) {
        faces.add(p.font);
      }
    }

    expect([...faces]).toContain('Size2-Regular');
  });
});
