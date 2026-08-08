// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { marked } from 'marked';
import { Markdown } from '../src/Markdown';
import { DEFAULT_THEME } from '../src/theme';

/**
 * A single-tilde run (`H~2~O`) renders as real subscript, not strikethrough.
 *
 * ## What the defect was
 *
 * `marked`'s GFM tokenizer emits a `del` token for a SINGLE-tilde run as well as
 * for the double-tilde strikethrough it is meant for. Measured against
 * marked@18.0.7:
 *
 * | Source        | Token                            |
 * | ------------- | -------------------------------- |
 * | `~~gone~~`    | `del`, `raw: '~~gone~~'`         |
 * | `~2~`         | `del`, `raw: '~2~'`              |
 *
 * `text` is `gone` / `2` in both cases, so the token type and text cannot tell
 * them apart — only `raw` can. `collectSpans`' `del` arm applied `lineThrough`
 * unconditionally, so `H~2~O` painted the `2` with a strikethrough and a reader
 * saw H2̶O.
 *
 * ## What it does now
 *
 * `TextStyle.baselineShift` landed (`DEC-0001`), so a single-tilde run is real
 * subscript: the content shrinks by `theme.subscriptScale` and drops by
 * `theme.subscriptShift` em (of the unscaled run size), matching
 * `markdown-it-sub`. The `~` delimiters are NOT printed — this is now a
 * supported construct, not a literal-source fallback (contrast the earlier
 * behaviour recorded in `DEC-01KZDK44`, superseded by the baseline-shift field).
 *
 * ## Why the strikethrough controls are load-bearing
 *
 * `~~x~~` is supported and must keep working. Every assertion here that pins the
 * single-tilde behaviour has a double-tilde counterpart, because a "fix" that
 * stopped striking BOTH forms would satisfy the subscript assertions alone while
 * silently deleting a shipped feature.
 *
 * The one assertion no sabotage can break is the lexer pin, which asserts
 * `marked`'s behaviour rather than this renderer's. That is its job: it fails
 * only if a future `marked` changes, which is exactly when this arm needs
 * revisiting.
 */

HTMLCanvasElement.prototype.getContext = (() => null) as never;

/** Every span in the tree, flattened, with its style. */
function allSpans(md: Markdown): Array<{ text: string; style?: Record<string, unknown> }> {
  const out: Array<{ text: string; style?: Record<string, unknown> }> = [];
  const walk = (entity: { children?: unknown[] }): void => {
    const spans = (
      entity as {
        spans?: Array<{ text: string; style?: Record<string, unknown> }>;
      }
    ).spans;
    for (const span of spans ?? []) out.push(span);
    for (const child of entity.children ?? []) walk(child as { children?: unknown[] });
  };
  walk(md as unknown as { children?: unknown[] });
  return out;
}

/** All projected text, spans and plain `Text` entities alike. */
function projectedText(md: Markdown): string {
  let out = '';
  const walk = (entity: { children?: unknown[] }): void => {
    const spans = (entity as { spans?: Array<{ text?: string }> }).spans;
    for (const span of spans ?? []) out += span.text ?? '';
    const withText = entity as { text?: unknown };
    if (typeof withText.text === 'string') out += withText.text;
    for (const child of entity.children ?? []) walk(child as { children?: unknown[] });
  };
  walk(md as unknown as { children?: unknown[] });
  return out;
}

/** The text of every span carrying `lineThrough`. */
function struckTexts(md: Markdown): string[] {
  return allSpans(md)
    .filter((s) => s.style?.lineThrough === true)
    .map((s) => s.text);
}

/** The text of every span carrying a negative `baselineShift` (subscript). */
function subscriptTexts(md: Markdown): string[] {
  return allSpans(md)
    .filter(
      (s) => typeof s.style?.baselineShift === 'number' && (s.style.baselineShift as number) < 0,
    )
    .map((s) => s.text);
}

const BODY_SIZE = DEFAULT_THEME.fontSize;
const EXPECTED_SUBSCRIPT_SIZE = BODY_SIZE * DEFAULT_THEME.subscriptScale;
const EXPECTED_SUBSCRIPT_SHIFT = BODY_SIZE * DEFAULT_THEME.subscriptShift;

describe('single-tilde lexing (the upstream cause)', () => {
  it('marked emits del for a single-tilde run, indistinguishable by type or text', () => {
    // Pins the upstream behaviour this fix exists to work around. If a future
    // marked stops emitting `del` for `~2~`, this fails and the arm below can go.
    const single = (
      marked.lexer('H~2~O')[0] as {
        tokens: Array<{ type: string; raw: string }>;
      }
    ).tokens;
    const double = (marked.lexer('a ~~gone~~ b')[0] as { tokens: Array<{ type: string }> }).tokens;
    expect(single.map((t) => t.type)).toEqual(['text', 'del', 'text']);
    expect(double.map((t) => t.type)).toEqual(['text', 'del', 'text']);
    // `raw` is the only discriminator.
    expect(single[1].raw).toBe('~2~');
  });
});

describe('single-tilde renders as real subscript', () => {
  it('does not strike H~2~O', () => {
    expect(struckTexts(new Markdown('H~2~O', { width: 600 }))).toEqual([]);
  });

  it('does not print the ~ delimiters', () => {
    expect(projectedText(new Markdown('H~2~O', { width: 600 }))).toBe('H2O');
  });

  it('shrinks and lowers the subscript content, leaving H and O unstyled', () => {
    const spans = allSpans(new Markdown('H~2~O', { width: 600 }));
    expect(spans.map((s) => s.text)).toEqual(['H', '2', 'O']);
    expect(spans[0].style).toBeUndefined();
    expect(spans[2].style).toBeUndefined();
    expect(spans[1].style?.fontSize).toBeCloseTo(EXPECTED_SUBSCRIPT_SIZE);
    expect(spans[1].style?.baselineShift).toBeCloseTo(EXPECTED_SUBSCRIPT_SHIFT);
  });

  it('subscripts a single-tilde run that is a whole word', () => {
    // `a~b~c` is the intraword form; `~2~` in `H~2~O` is the same shape. Both lex
    // to `del`, so both must be covered.
    expect(struckTexts(new Markdown('a~b~c', { width: 600 }))).toEqual([]);
    expect(subscriptTexts(new Markdown('a~b~c', { width: 600 }))).toEqual(['b']);
    expect(projectedText(new Markdown('a~b~c', { width: 600 }))).toBe('abc');
  });
});

describe('double-tilde strikethrough still works (controls)', () => {
  it('strikes ~~gone~~', () => {
    // THE load-bearing control. A fix that removed the `lineThrough` arm outright
    // would pass every assertion above and silently unship GFM strikethrough.
    expect(struckTexts(new Markdown('a ~~gone~~ b', { width: 600 }))).toEqual(['gone']);
  });

  it('does not print the ~~ delimiters', () => {
    expect(projectedText(new Markdown('a ~~gone~~ b', { width: 600 }))).toBe('a gone b');
  });

  it('does not apply subscript shift to a strikethrough run', () => {
    const spans = allSpans(new Markdown('a ~~gone~~ b', { width: 600 }));
    const struck = spans.find((s) => s.style?.lineThrough === true);
    expect(struck?.style?.baselineShift).toBeUndefined();
  });

  it('strikes inner markup inside a strikethrough', () => {
    // `~~*em*~~` recurses, so the em span must carry BOTH styles.
    const spans = allSpans(new Markdown('~~*em*~~', { width: 600 }));
    expect(spans).toHaveLength(1);
    expect(spans[0].text).toBe('em');
    expect(spans[0].style).toMatchObject({ lineThrough: true, italic: true });
  });
});

describe('the two forms in one document', () => {
  it('strikes only the double-tilde run, subscripts only the single-tilde one', () => {
    const md = new Markdown('H~2~O and ~~del~~', { width: 600 });
    expect(struckTexts(md)).toEqual(['del']);
    expect(subscriptTexts(md)).toEqual(['2']);
    expect(projectedText(md)).toBe('H2O and del');
  });
});

describe('inner markup and inherited style', () => {
  it('renders emphasis inside a single-tilde run, still subscripted', () => {
    // Recursing rather than dumping `raw` is what makes this work: `~*em*~` keeps
    // its emphasis as well as the subscript shift.
    const spans = allSpans(new Markdown('~*em*~', { width: 600 }));
    expect(spans.map((s) => s.text)).toEqual(['em']);
    expect(spans[0].style).toMatchObject({ italic: true });
    expect(spans[0].style?.lineThrough).toBeUndefined();
    expect(spans[0].style?.baselineShift).toBeCloseTo(EXPECTED_SUBSCRIPT_SHIFT);
  });

  it('carries the surrounding run style onto the subscript content', () => {
    // Inside `**…**` the subscript is bold like the prose around it, rather than
    // reverting to body style.
    const spans = allSpans(new Markdown('**H~2~O**', { width: 600 }));
    expect(spans.map((s) => s.text)).toEqual(['H', '2', 'O']);
    expect(spans.every((s) => s.style?.bold === true)).toBe(true);
    expect(spans.every((s) => s.style?.lineThrough === undefined)).toBe(true);
    expect(spans[1].style?.baselineShift).toBeCloseTo(EXPECTED_SUBSCRIPT_SHIFT);
  });

  it('keeps a nested single-tilde run struck (not subscripted) when it sits inside a strikethrough', () => {
    // `~~a ~b~ c~~` lexes as an outer `del` containing an inner `del`. The inner
    // tildes are CONTENT of a struck region, so they inherit `lineThrough` — the
    // fix suppresses the arm's own subscript styling on that path, not inherited
    // striking.
    const md = new Markdown('~~a ~b~ c~~', { width: 600 });
    expect(projectedText(md)).toBe('a b c');
    expect(allSpans(md).every((s) => s.style?.lineThrough === true)).toBe(true);
  });
});

describe('constructs that were never del tokens are untouched', () => {
  it('leaves an escaped tilde as a literal character', () => {
    expect(projectedText(new Markdown('H\\~2\\~O', { width: 600 }))).toBe('H~2~O');
    expect(struckTexts(new Markdown('H\\~2\\~O', { width: 600 }))).toEqual([]);
    expect(subscriptTexts(new Markdown('H\\~2\\~O', { width: 600 }))).toEqual([]);
  });

  it('leaves tildes inside inline code alone', () => {
    const md = new Markdown('`~x~`', { width: 600 });
    expect(projectedText(md)).toBe('~x~');
    expect(struckTexts(md)).toEqual([]);
    expect(subscriptTexts(md)).toEqual([]);
  });

  it('leaves an unpaired tilde alone', () => {
    // `~~a~` and `a ~ b` never reach the `del` arm; asserted so a future regex
    // change to the arm cannot start claiming them.
    expect(projectedText(new Markdown('a ~ b', { width: 600 }))).toBe('a ~ b');
    expect(struckTexts(new Markdown('~~a~', { width: 600 }))).toEqual([]);
  });
});
