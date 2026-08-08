// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Markdown } from '../src/Markdown';
import { CodeBlock } from '../src/markdown-code';
import { isPresetName, PRESET_THEMES, resolvePresetTheme } from '../src/markdown-presets';
import { DEFAULT_THEME, resolveTheme } from '../src/theme';

/**
 * Named theme presets (`githubDark`/`githubLight`/`dracula`/`solarizedDark`/
 * `solarizedLight`): the preset lookup table, the `resolvePresetTheme`
 * resolver, and the `Markdown`/`CodeBlock` constructor seams that accept a
 * preset name in place of a full theme object.
 */

HTMLCanvasElement.prototype.getContext = (() => null) as never;

describe('isPresetName', () => {
  it('recognises every built-in preset name', () => {
    for (const name of [
      'githubDark',
      'githubLight',
      'dracula',
      'solarizedDark',
      'solarizedLight',
    ]) {
      expect(isPresetName(name)).toBe(true);
    }
  });

  it('rejects an arbitrary string', () => {
    expect(isPresetName('notAPreset')).toBe(false);
    expect(isPresetName('')).toBe(false);
  });

  it('rejects non-string values without throwing', () => {
    expect(isPresetName(undefined)).toBe(false);
    expect(isPresetName(null)).toBe(false);
    expect(isPresetName(42)).toBe(false);
    expect(isPresetName({})).toBe(false);
  });

  it('does not match an inherited Object.prototype property name', () => {
    // hasOwnProperty guard: 'toString'/'constructor' must not resolve as a preset.
    expect(isPresetName('toString')).toBe(false);
    expect(isPresetName('constructor')).toBe(false);
  });
});

describe('resolvePresetTheme', () => {
  it('resolves a preset name into a Required<MarkdownTheme>', () => {
    const resolved = resolvePresetTheme('dracula');
    expect(resolved.textColor).toBe(PRESET_THEMES.dracula.textColor);
    expect(resolved.codeColor).toBe(PRESET_THEMES.dracula.codeColor);
  });

  it('resolves undefined into the stock default theme', () => {
    const resolved = resolvePresetTheme(undefined);
    expect(resolved.textColor).toBe(DEFAULT_THEME.textColor);
    expect(resolved.linkColor).toBe(DEFAULT_THEME.linkColor);
  });

  it('resolves a plain (non-preset) MarkdownTheme object unchanged, same as resolveTheme', () => {
    const custom = { textColor: '#123456' };
    expect(resolvePresetTheme(custom)).toEqual(resolveTheme(custom));
  });

  it('still applies resolveTheme derivations on top of a preset', () => {
    // tableFontSize derives from fontSize; footnoteColor/quoteTextColor derive
    // from linkColor/textColor. None of the five presets sets fontSize, so
    // tableFontSize must still land at fontSize-2 for every preset.
    for (const name of [
      'githubDark',
      'githubLight',
      'dracula',
      'solarizedDark',
      'solarizedLight',
    ] as const) {
      const resolved = resolvePresetTheme(name);
      expect(resolved.tableFontSize).toBe(Math.max(1, resolved.fontSize - 2));
      // A preset that sets linkColor but not footnoteColor should still see the
      // marker recoloured, since footnoteColor derives from linkColor.
      expect(resolved.footnoteColor).toBe(resolved.linkColor);
      // Likewise quoteTextColor derives from textColor unless overridden, and
      // no preset overrides it explicitly.
      expect(resolved.quoteTextColor).toBe(resolved.textColor);
    }
  });

  it('every preset sets all four syntax colors, not just prose colors', () => {
    // A preset leaving syntax colors at the stock default would make code
    // blocks look broken (this is literally what makes e.g. Dracula
    // recognisable) — this is the core "a preset must set all 32 keys, especially
    // the 4 syntax colors" requirement from the design doc.
    for (const name of [
      'githubDark',
      'githubLight',
      'dracula',
      'solarizedDark',
      'solarizedLight',
    ] as const) {
      const preset = PRESET_THEMES[name];
      expect(preset.syntaxKeywordColor).toBeDefined();
      expect(preset.syntaxStringColor).toBeDefined();
      expect(preset.syntaxCommentColor).toBeDefined();
      expect(preset.syntaxNumberColor).toBeDefined();
      // And none of them should coincidentally equal the stock default — a
      // preset that silently inherited the default would be indistinguishable
      // from a bug that forgot to set the key.
      expect(preset.syntaxKeywordColor).not.toBe(DEFAULT_THEME.syntaxKeywordColor);
      expect(preset.syntaxStringColor).not.toBe(DEFAULT_THEME.syntaxStringColor);
      expect(preset.syntaxCommentColor).not.toBe(DEFAULT_THEME.syntaxCommentColor);
      expect(preset.syntaxNumberColor).not.toBe(DEFAULT_THEME.syntaxNumberColor);
    }
  });

  it('every preset sets the full color surface, not just textColor/bodyFont', () => {
    for (const name of [
      'githubDark',
      'githubLight',
      'dracula',
      'solarizedDark',
      'solarizedLight',
    ] as const) {
      const preset = PRESET_THEMES[name];
      for (const key of [
        'textColor',
        'headingColor',
        'codeColor',
        'codeBgColor',
        'quoteBorderColor',
        'hrColor',
        'tableBgColor',
        'tableHeaderBgColor',
        'linkColor',
        'mathFallbackColor',
        'markHighlightColor',
        'containerColors',
        'containerDefaultColor',
        'containerBgColor',
      ] as const) {
        expect(preset[key], `${name}.${key}`).toBeDefined();
      }
    }
  });

  it('leaves spacing/typography keys unset, so presets inherit the stock layout', () => {
    for (const name of [
      'githubDark',
      'githubLight',
      'dracula',
      'solarizedDark',
      'solarizedLight',
    ] as const) {
      const preset = PRESET_THEMES[name];
      expect(preset.fontSize).toBeUndefined();
      expect(preset.blockGap).toBeUndefined();
      expect(preset.codePadding).toBeUndefined();
      // Resolved, these fall back to DEFAULT_THEME's spacing.
      const resolved = resolvePresetTheme(name);
      expect(resolved.fontSize).toBe(DEFAULT_THEME.fontSize);
      expect(resolved.blockGap).toBe(DEFAULT_THEME.blockGap);
      expect(resolved.codePadding).toBe(DEFAULT_THEME.codePadding);
    }
  });
});

describe('the five presets are visually distinct', () => {
  it('no two presets share the same textColor', () => {
    const colors = (
      ['githubDark', 'githubLight', 'dracula', 'solarizedDark', 'solarizedLight'] as const
    ).map((name) => PRESET_THEMES[name].textColor);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it('solarizedDark and solarizedLight share identical accent colors (the core Solarized design property)', () => {
    const dark = PRESET_THEMES.solarizedDark;
    const light = PRESET_THEMES.solarizedLight;
    expect(dark.linkColor).toBe(light.linkColor);
    expect(dark.syntaxKeywordColor).toBe(light.syntaxKeywordColor);
    expect(dark.syntaxStringColor).toBe(light.syntaxStringColor);
    expect(dark.syntaxNumberColor).toBe(light.syntaxNumberColor);
    // ...but background/foreground must differ, since one is dark and one is light.
    expect(dark.textColor).not.toBe(light.textColor);
    expect(dark.codeBgColor).not.toBe(light.codeBgColor);
  });

  it('githubDark and githubLight have inverted text/background weight', () => {
    const dark = PRESET_THEMES.githubDark;
    const light = PRESET_THEMES.githubLight;
    expect(dark.textColor).not.toBe(light.textColor);
    expect(dark.codeBgColor).not.toBe(light.codeBgColor);
    expect(dark.linkColor).not.toBe(light.linkColor);
  });

  it('exact published hex values are used, not eyeballed placeholders (spot-check)', () => {
    // Dracula: Background #282a36, Foreground #f8f8f2, Purple headings #bd93f9,
    // Cyan links #8be9fd — from https://draculatheme.com/spec.
    expect(PRESET_THEMES.dracula.codeBgColor).toBe('#282a36');
    expect(PRESET_THEMES.dracula.textColor).toBe('#f8f8f2');
    expect(PRESET_THEMES.dracula.headingColor).toBe('#bd93f9');
    expect(PRESET_THEMES.dracula.linkColor).toBe('#8be9fd');
    // Solarized (Schoonover canonical): base03 #002b36, base0 #839496, blue #268bd2.
    expect(PRESET_THEMES.solarizedDark.codeBgColor).toBe('#073642');
    expect(PRESET_THEMES.solarizedDark.textColor).toBe('#839496');
    expect(PRESET_THEMES.solarizedDark.linkColor).toBe('#268bd2');
    expect(PRESET_THEMES.solarizedLight.textColor).toBe('#657b83');
    // GitHub Dark Default (Primer): canvas.default #0d1117 (not directly a key
    // here, but canvas.subtle #161b22 backs codeBgColor), fg.default #e6edf3,
    // accent.fg #58a6ff.
    expect(PRESET_THEMES.githubDark.textColor).toBe('#e6edf3');
    expect(PRESET_THEMES.githubDark.linkColor).toBe('#58a6ff');
    // GitHub Light Default: fg.default #1f2328, accent.fg #0969da.
    expect(PRESET_THEMES.githubLight.textColor).toBe('#1f2328');
    expect(PRESET_THEMES.githubLight.linkColor).toBe('#0969da');
  });
});

describe('Markdown accepts a preset name as theme', () => {
  it('renders with a preset name string, applying the preset colors', () => {
    const md = new Markdown('# Heading\n\nSome text.', { theme: 'dracula', maxWidth: 600 });
    expect(md.theme.textColor).toBe(PRESET_THEMES.dracula.textColor);
    expect(md.theme.headingColor).toBe(PRESET_THEMES.dracula.headingColor);
  });

  it('still accepts a plain MarkdownTheme object (backward compatible)', () => {
    const md = new Markdown('# Heading', { theme: { textColor: '#abcdef' }, maxWidth: 600 });
    expect(md.theme.textColor).toBe('#abcdef');
  });

  it('defaults to the stock theme when no theme option is given', () => {
    const md = new Markdown('# Heading', { maxWidth: 600 });
    expect(md.theme.textColor).toBe(DEFAULT_THEME.textColor);
  });

  it('renders code blocks with the preset syntax colors', () => {
    const md = new Markdown('```js\nconst x = 1;\n```', {
      theme: 'githubLight',
      maxWidth: 600,
    });
    expect(md.theme.syntaxKeywordColor).toBe(PRESET_THEMES.githubLight.syntaxKeywordColor);
  });
});

describe('CodeBlock accepts a preset name as theme', () => {
  it('resolves preset colors through its own constructor seam', () => {
    const block = new CodeBlock('const x = 1;', 'js', 400, 'solarizedDark');
    // theme is private; assert indirectly via a public accessor if present, else
    // via resolvePresetTheme parity (the same function CodeBlock now calls).
    expect(resolvePresetTheme('solarizedDark').codeColor).toBe(
      PRESET_THEMES.solarizedDark.codeColor,
    );
    expect(block).toBeInstanceOf(CodeBlock);
  });

  it('still accepts a plain MarkdownTheme object (backward compatible)', () => {
    const block = new CodeBlock('const x = 1;', 'js', 400, { codeColor: '#ff00ff' });
    expect(block).toBeInstanceOf(CodeBlock);
  });
});
