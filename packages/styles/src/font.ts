/**
 * Font shorthand composition for `fontFamily`/`fontSize`/`fontWeight`.
 *
 * ui components carry the whole font as one CSS-font-shorthand string (e.g.
 * `'700 16px Inter'`), so the three CSS-named keys are not independent fields.
 * This module parses the entity's current shorthand, replaces the segments
 * the style changes, and writes the recomposed string — the only place in the
 * package that understands font grammar, and it is fully test-covered.
 */

const WEIGHT_RE = /^(normal|bold|bolder|lighter|[1-9]00)$/;
// Deliberately branch-safe: no adjacent same-class quantifiers (`\d+\.?\d*`
// overlaps digit classes and is what CodeQL flags as polynomial-redos), and
// the longer unit alternatives come first so `em|rem` is never a prefix pair.
const SIZE_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:rem|em|px|pt)$/;

interface FontParts {
  weight?: string;
  size?: string;
  family?: string;
}

function parse(font: string): FontParts {
  const tokens = font.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return {};
  const parts: FontParts = {};
  let i = 0;
  if (WEIGHT_RE.test(tokens[0] ?? '')) {
    parts.weight = tokens[i];
    i++;
  }
  if (SIZE_RE.test(tokens[i] ?? '')) {
    parts.size = tokens[i];
    i++;
  }
  const family = tokens.slice(i).join(' ');
  if (family) parts.family = family;
  return parts;
}

/** Recompose a font shorthand from a parse result. */
function compose(parts: FontParts): string {
  return [parts.weight, parts.size, parts.family].filter((p): p is string => !!p).join(' ');
}

/**
 * Replace the font segments a style changes, preserving everything else.
 * A missing current font starts from `16px` (size required for a valid
 * canvas font string); a missing family falls back to `sans-serif`.
 */
export function composeFont(
  current: string,
  changes: { fontFamily?: string; fontSize?: string; fontWeight?: string },
): string {
  const parts = parse(current);
  if (changes.fontWeight !== undefined) parts.weight = changes.fontWeight;
  if (changes.fontSize !== undefined) parts.size = changes.fontSize;
  if (changes.fontFamily !== undefined) parts.family = changes.fontFamily;
  parts.size ??= '16px';
  parts.family ??= 'sans-serif';
  return compose(parts);
}
