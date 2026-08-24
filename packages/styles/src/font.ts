/**
 * Font shorthand composition for `fontFamily`/`fontSize`/`fontWeight`.
 *
 * ui components carry the whole font as one CSS-font-shorthand string (e.g.
 * `'700 16px Inter'`), so the three CSS-named keys are not independent fields.
 * This module parses the entity's current shorthand, replaces the segments
 * the style changes, and writes the recomposed string — the only place in the
 * package that understands font grammar, and it is fully test-covered.
 *
 * The parser understands the full canvas shorthand prefix grammar
 * `[style || variant || weight]? size[/line-height]? family` (GH-608): an
 * `italic 700 16px Georgia` or `16px/24px Inter` value used to collapse
 * everything around the size into the family, so a later segment change
 * recomposed an invalid string that Canvas2D silently drops. Size-like
 * segments it cannot place fail loudly instead of being buried in the family.
 */

const WEIGHT_RE = /^(normal|bold|bolder|lighter|[1-9]00)$/;
const STYLE_RE = /^(?:italic|oblique)$/;
const VARIANT_RE = /^(?:small-caps)$/;

/** `<size>` or `<size>/<line-height>` at the size slot. Deliberately
 *  branch-safe: no adjacent same-class quantifiers (`\d+\.?\d*` overlaps
 *  digit classes and is what CodeQL flags as polynomial-redos), and the
 *  longer unit alternatives come first so `em|rem` is never a prefix pair. */
const SIZE_SLOT_RE = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:rem|em|px|pt))(?:\/([^\s/]+))?$/;
/** A leading numeric literal — the start of a size or line-height segment. */
const NUMERIC_PREFIX_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)/;

interface FontParts {
  style?: string;
  variant?: string;
  weight?: string;
  size?: string;
  lineHeight?: string;
  family?: string;
}

/** Consume leading `style`/`variant`/`weight` keywords (at most one each). */
function parsePrefixes(tokens: string[], parts: FontParts): number {
  let i = 0;
  // 'normal' is ambiguous; it has always slotted into weight, so keep that
  // precedence for backward compatibility.
  for (; i < tokens.length && i < 3; i++) {
    const token = tokens[i] ?? '';
    if (parts.weight === undefined && WEIGHT_RE.test(token)) {
      parts.weight = token;
    } else if (token === 'normal' && (parts.style === undefined || parts.variant === undefined)) {
      // A second `normal` once the weight slot is taken: CSS allows `normal`
      // in the style and variant positions too (`font: normal normal 16px Inter`
      // is a valid shorthand), so fill those slots in order instead of letting
      // the token fall into the size slot and throw.
      if (parts.style === undefined) parts.style = token;
      else parts.variant = token;
    } else if (parts.style === undefined && STYLE_RE.test(token)) {
      parts.style = token;
    } else if (parts.variant === undefined && VARIANT_RE.test(token)) {
      parts.variant = token;
    } else {
      break;
    }
  }
  return i;
}

/** A numeric-led token that is not plain family text: a misplaced or
 *  malformed size/line-height segment. Well-formed sizes were already
 *  consumed at the size slot, so anything numeric-led left over is junk. */
function isSizeLike(token: string): boolean {
  return NUMERIC_PREFIX_RE.test(token);
}

function parse(font: string): FontParts {
  const tokens = font.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return {};
  const parts: FontParts = {};
  const i = parsePrefixes(tokens, parts);
  const sizeMatch = SIZE_SLOT_RE.exec(tokens[i] ?? '');
  if (sizeMatch) {
    parts.size = sizeMatch[1];
    if (sizeMatch[2] !== undefined) parts.lineHeight = sizeMatch[2];
    parts.family = tokens.slice(i + 1).join(' ') || undefined;
    return parts;
  }
  // No usable size at the expected slot. Everything from here is either a
  // bare family list (tolerated: composed shorthands get defaults) or a
  // malformed size segment sitting where the size belongs — the latter must
  // fail loudly rather than collapse into a family Canvas2D silently ignores.
  const rest = tokens.slice(i);
  if (rest.some(isSizeLike)) {
    throw new TypeError(
      `@vectojs/styles: cannot parse font shorthand '${font}' — ` +
        `unrecognized segment '${rest[0]}' before the font size`,
    );
  }
  parts.family = rest.join(' ') || undefined;
  return parts;
}

/** Recompose a font shorthand from a parse result. */
function compose(parts: FontParts): string {
  const size = parts.lineHeight ? `${parts.size}/${parts.lineHeight}` : parts.size;
  return [parts.style, parts.variant, parts.weight, size, parts.family]
    .filter((p): p is string => !!p)
    .join(' ');
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
