---
title: "13 — Styles & Theming — CSS Parity on the Numeric VMT"
description: "Why VectoJS styles on the Virtual Math Tree, how CSS-property-name objects map to numeric entity fields, and every mechanism that makes them feel like CSS without being CSS — tokens and var() resolution, css() merging, font composition, per-axis padding, atomic theme switching, and the migration gotchas that keep the numeric tree honest."
order: 33
---

# 13 — Styles & Theming — CSS Parity on the Numeric VMT

> VectoJS has no stylesheet, no cascade, no browser. The Virtual Math Tree stores numbers — `x`, `width`, `bg`, `font` — not CSS strings. `@vectojs/styles` is the bridge that lets you _write_ those numbers as if they were CSS and still have them land as numbers: a typed object, a fixed lookup table, and a flat token theme that re-resolves on switch.

- **What you'll learn**: why styles live on the numeric VMT, how `Style` maps to entity fields, how `var(--token)` tokens resolve (anchored, embedded, transitive, with cycle detection), how `css()` merges and `style()` types, how `composeFont` keeps canvas shorthands valid, how per-axis `padding: {x,y}` fans out, how `setTheme` swaps atomically via `WeakRef`-tracked pairs, and every way migrating CSS habits can fail loudly instead of silently.
- **What you won't**: how text is shaped or laid out (boss 02), how the scene dirties and renders (bosses 06/07), or how Markdown themes its code blocks (`packages/markdown/src/markdown-presets.ts:281` `resolvePresetTheme` — a separate token system). This doc is the thin, typed, CSS-named skin over the numeric tree.

## 1. Why styles on the VMT — and why not CSS

The VMT stores the scene as numbers. `Entity.x: number` (`packages/core/src/tree/Entity.ts:1`), `UIComponent.paddingX: number` (`packages/ui/src/UIComponent.ts:28`), `Text.font: string` (`packages/ui/src/Text.ts:111`) that is still a _valid canvas font shorthand_ — not a stylesheet rule. There is no DOM element to inherit from, no cascade to resolve, no selector to match. The browser's style engine is absent by design: VectoJS owns paint, hit-test, and projection itself, so it owns sizing too.

`@vectojs/styles` leans into that constraint instead of fighting it:

- A `Style` is a plain object (`packages/styles/src/types.ts:16`) with **optional** keys — `x?: CssLength` (`types.ts:18`), `backgroundColor?: string` (`types.ts:28`), `fontSize?:`${number}px`` (`types.ts:46`), `display?: 'flex'` (`types.ts:62`). No class, no proxy, no registry.
- `applyStyle(entity, style)` (`packages/styles/src/apply.ts:294`) is a **fixed lookup table** `RULES: Record<string, Rule>` (`apply.ts:54`) that converts each CSS-named key into one numeric/string/boolean write. Every key is enumerated; an unknown key throws (`apply.ts:258`). No parsing, no inheritance, no `%`.
- Tokens are flat `Record<string, string|number>` (`packages/styles/src/theme.ts:38` `ThemeTokenSet`), referenced as `var(--key)` in values and resolved by string substitution against the active theme — not by a CSS engine.
- The package depends only on `@vectojs/core` (`packages/styles/package.json:14`) and has zero runtime deps; `@vectojs/ui` carries zero `@vectojs/styles` dep (the dependency graph is `core → styles`, ingestion is opt-in).

The payoff is migration comfort — `backgroundColor: 'var(--accent)'` reads like CSS and still lands on `entity.bg: string` (`apply.ts:63`) — while the VMT stays the single source of truth. The price is that anything CSS does that has no numeric backing field _does not exist_ and must fail loudly (see §10).

## 2. `Style` and the Rule table — every key is a contract

`CssLength = number |`${number}px`` (`packages/styles/src/types.ts:2`) — bare numbers are px, `px` strings are parsed to numbers. The distinction matters only for `fontSize`, which the type narrows to `` `${number}px` `` (`types.ts:46`) so a bare`16` is a type error — the composed font shorthand must stay valid.

`Style` (`types.ts:16`) groups keys by what they drive:

<!-- markdownlint-disable MD060 -->
| Group         | Keys                                                                                      | Backing field                                                      | Converter                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Geometry      | `x,y,width,height`                                                                        | same (`apply.ts:55`)                                               | `isCssLength` (`apply.ts:23`) — number or `/^[+-]?(\d+\.?\d*                                \| \.\d+)px$/` |
| Transform     | `scaleX,scaleY,rotation,opacity`                                                          | same (`apply.ts:59`)                                               | `isFiniteNumber` (`apply.ts:33`); `rotation` is **radians** (`types.ts:25`) not CSS degrees |
| Box           | `backgroundColor→bg`, `color`, `borderColor`, `borderRadius→radius`, `padding`            | `apply.ts:63`                                                      | `isString` / `isCssLength`                                                                  |
| Text          | `font`, `lineHeight`, `textAlign`                                                         | same / `textAlign` via `oneOf(['left','justify'])` (`apply.ts:70`) | `types.ts:55` — `center`/`right` are rejected loudly                                        |
| Layout        | `display→null`, `flexDirection→direction`, `gap→gap`, `alignItems→align`, `flexWrap→wrap` | `apply.ts:71`                                                      | `oneOf` + enum remap (`row→horizontal`, `flex-start→start`, `wrap→true`)                    |
| Font segments | `fontFamily,fontSize,fontWeight`                                                          | composed into `font` (`apply.ts:101` `FONT_KEYS`)                  | `composeFont` (`packages/styles/src/font.ts:113`)                                           |

Three rules about those converters:

1. **Cross-component skipping is silent.** `write()` checks `field in entity` (`apply.ts:186`); a `Text` has no `bg`, a `Button` has no `textAlign` — the key is skipped and absent from `AppliedStyle.applied: string[]` (`types.ts:71`). One style object can be shared across components.
2. **Category errors throw.** A layout key on a non-container (`!('direction' in entity)` at `apply.ts:194` or `field===null && !('direction' in entity)` at `apply.ts:194`) is a `TypeError` naming the property and `entity.constructor.name` (`apply.ts:189`). Styling a `Text` as `display: flex` is a mistake, not a no-op.
3. **`display` writes no field.** `field: null` (`apply.ts:72`) — it validates that the entity _is_ a container and that the value is `'flex'` (`apply.ts:74`), then contributes to `applied` without touching the entity. The container already _is_ flex; the key exists so a mistyped container style fails.

Validation is strict: `isCssLength` rejects `'50%'`, `'8em'` (`packages/styles/test/styles.test.ts:35`), `oneOf` rejects `stretch`/`row-reverse`/`block` (`styles.test.ts:150`), unknown keys throw `unknown style property 'position'` (`styles.test.ts:159`).

## 3. The `applyStyle` pipeline — resolve, then write

```ts
export function applyStyle(entity: Entity, s: Style): AppliedStyle {
  const { style: resolved } = resolveStyle(s, getTheme()); // theme.ts:96 getTheme / apply.ts:162 resolveStyle
  const result = applyStyleResolved(entity, resolved); // apply.ts:180
  trackVarKeys(entity, s); // theme.ts:175 — register var() keys under current theme
  return result;
}
```

`resolveStyle` (`apply.ts:162`) walks the style object, calling `resolveValue(value, theme)` (`apply.ts:137`) per value — with a special branch for `padding: {x,y}` (`apply.ts:166`) that resolves each axis independently. `resolveValue` has four arms:

1. Non-string → pass through.
2. Anchored `var(--key)` (`theme.ts:6` `VAR_RE = /^var\(--([\w-]+)\)$/`) → `resolveToken(key, theme, seen)` (`apply.ts:112`) which looks up `theme.tokens[key]` and recurses transitively via `resolveValue(token, theme, seen)`.
3. Fallback form `var(--key, …)` (`theme.ts:24` `HAS_VAR_FALLBACK_RE = /var\(\s*--[\w-]+\s*,/`) → throw `TypeError` naming the value (`apply.ts:148`). Checked **before** the embedded path so composites are covered too.
4. Embedded `var(--key)` anywhere (`theme.ts:11` `HAS_VAR_RE = /var\(--([\w-]+)\)/`) → global replace via `VAR_REPLACE_RE = /var\(--([\w-]+)\)/g` (`apply.ts:105`) substituting `String(resolveToken(key,…))` per occurrence (`apply.ts:156`).

`applyStyleResolved` (`apply.ts:180`) is the numeric write. It handles the two special shapes first — `FONT_KEYS` (`apply.ts:207`) via `composeFont` and `padding` objects (`apply.ts:242`) by writing `paddingX`/`paddingY` (`apply.ts:248` `isCssLength(v, 'padding.x')`) — then walks `RULES` for everything else via `write()` (`apply.ts:185`). Font-touching styles set `fontTouched` and recompose once at the end (`apply.ts:265` `composeFont(current, fontChanges)`). When `applied.length > 0`, `entity.scene?.markDirty()` fires once (`apply.ts:271`), honouring the `onDemand` contract. No scene → no dirty call (`styles.test.ts:182`).

Return value is `{ applied: string[] }` (`types.ts:71`) — the CSS property names actually written, in object order — so a caller can branch on `applied.includes('padding')` without re-inspecting the entity.

## 4. Token system — `tokens()`, `PRESET_THEMES`, and `var()` semantics

### 4.1 Creating a theme

```ts
export type ThemeTokenSet = Record<string, string | number>; // theme.ts:38
export interface Theme {
  readonly tokens: ThemeTokenSet;
} // theme.ts:41
export function tokens(set: ThemeTokenSet): Theme {
  return { tokens: set };
} // theme.ts:46
export const DEFAULT_THEME: Theme = tokens(PRESET_THEMES.light); // theme.ts:51
```

Flat by design — like `MarkdownTheme` — single spread, no deep merge, no nesting (`theme.ts:35`). `PRESET_THEMES` (`packages/styles/src/presets.ts:12`) ships `light | dark | github | dracula` (`presets.ts:12`), each with `accent/surface/surfaceAlt/text/muted/border/radius-sm/md/lg/font/fontFamily/fontSize/fontWeight/fontMono` (`presets.ts:13`). A caller theme is a spread: `tokens({ ...PRESET_THEMES.dark, accent: '#f00' })` (`vectojs-docs/content/reference/styles.md:136`). Keys are stored without `--`; references write `var(--key)` (`theme.ts:28`).

### 4.2 Anchored, embedded, and transitive resolution

- **Anchored** — `backgroundColor: 'var(--accent)'` resolves the token value directly (`resolveValue` early return at `apply.ts:140`), preserving its type: a numeric token `gap: 10` stays `number` and flows into `isCssLength` without stringification. Whole-string identity is what lets `gap: 'var(--gap)'` with `gap: 12` produce `e.gap === 12` as a number (`packages/styles/test/v2.test.ts:70`).
- **Embedded** — `'rgba(var(--rgb), 0.4)'` with `rgb: '255, 0, 0'` substitutes each occurrence via `String(resolveToken(...))` (`apply.ts:157`), yielding `'rgba(255, 0, 0, 0.4)'` (`packages/styles/test/issue-608.test.ts:39`). Two occurrences of the same token share one resolution pass and do not trip the cycle detector (`issue-608.test.ts:99` `shadow` with two `var(--rgb)`).
- **Transitive** — a token `alias: 'var(--accent)'` with `accent: '#123456'` resolves `var(--alias)` to `var(--accent)` to `'#123456'` (`packages/styles/test/v2.test.ts:353`). Chains are followed via `resolveValue(token, theme, seen)` inside `resolveToken` (`apply.ts:125`), so a composite token `surface: 'rgba(var(--rgb), 1)'` with `rgb: '17, 34, 51'` yields `'rgba(17, 34, 51, 1)'` when dereferenced as `var(--surface)` (`issue-608.test.ts:78`).

`resolveToken` carries `seen: Set<string>` (`apply.ts:112`) — the path of keys in the current resolution. `seen.has(key)` means a cycle; throw `circular var() reference: var(--a) → var(--b) → var(--a)` (`apply.ts:121`). `seen.delete(key)` in `finally` (`apply.ts:127`) makes sibling references to the same token independent — `rgba(var(--rgb), var(--rgb))` would otherwise false-positive on the second occurrence.

### 4.3 What throws, and why silence is never correct

| Condition                                | Where                                                               | Message                                                                           | Why it must throw                                                                                                                                                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unknown token                            | `resolveToken` `apply.ts:116`                                       | `unknown token 'var(--nope)'`                                                     | Canvas2D silently keeps the previous paint when the field receives garbage (`v2.test.ts:253`, `issue-608.test.ts:16` anchored miss)                                                                                                                                             |
| Circular chain                           | `resolveToken` `apply.ts:121`                                       | `circular var() reference: … → …`                                                 | Infinite substitution would hang or emit the literal `var(--…)`                                                                                                                                                                                                                 |
| `var(--k, fallback)` — any arrival path  | `resolveValue` `apply.ts:148` + `HAS_VAR_FALLBACK_RE` `theme.ts:24` | `var() fallbacks are not supported — '…' would reach the entity field unresolved` | Neither `VAR_RE` nor `HAS_VAR_RE` matches it (`)` must follow the key), so without this guard the raw string reached mapped fields while Canvas2D silently kept the old value and the key went untracked for theme switches (#645, `packages/styles/test/issue-645.test.ts:40`) |
| `fontSize` bare number or non-px         | `applyStyleResolved` `apply.ts:221` + `apply.ts:232`                | `fontSize resolved to the bare number …` / `expects a px string`                  | A bare `16` composes `'700 16 Inter'` — Canvas2D silently drops it (`v2.test.ts:254`)                                                                                                                                                                                           |
| `fontFamily` that looks like a shorthand | `applyStyleResolved` `apply.ts:214`                                 | `looks like a font shorthand — reference the 'font' token`                        | `'16px Inter'` leaked into `fontFamily` would discard size/weight                                                                                                                                                                                                               |

The fallback detector tolerates whitespace after `var(` (`/var\(\s*--/` in `HAS_VAR_FALLBACK_RE` at `theme.ts:24`) so `var( --accent, #fff)` is caught too — stray spaces are common and the pre-#753 detector missing them let the value pass through (`issue-645.test.ts:78`).

The type layer narrows `fontSize` to `` `${number}px` `` (`types.ts:46`); JS callers and token values bypass the type, so the runtime enforces it too — `'2em'` from a token still throws (`issue-608.test.ts:141`).

## 5. `css()` merging and `style()` typing — the variant pattern

```ts
export function css<T extends Style>(
  ...styles: Array<T | null | undefined | false>
): T {
  // css.ts:17
  const merged: Record<string, unknown> = {};
  for (const s of styles) {
    if (!s) continue; // css.ts:20
    for (const [key, value] of Object.entries(s)) {
      merged[key] =
        key === "padding" && typeof value === "object" && value !== null
          ? { ...(value as object) } // css.ts:23 — per-axis padding deep-copy
          : value;
    }
  }
  return merged as T;
}
export function style<T extends Style>(s: T): T {
  return s;
} // css.ts:32
```

`style()` is an identity factory — types the literal as `Style`, returns it unchanged (`packages/styles/test/styles.test.ts:18`). `css()` is the variant merge: later sources win, `null`/`undefined`/`false` are skipped so conditional variants are `css(base, isMuted && muted)` (`css.ts:11`), inputs are not mutated (`v2.test.ts:49`), and the one nested shape — `padding: { x, y }` (`types.ts:34`) — is copied (`css.ts:23`) so mutating `merged.padding.x` never reaches into a source variant (GH-608, `issue-608.test.ts:153`). Replacing `padding` wholesale is also copied — `merged.padding !== override.padding` (`issue-608.test.ts:163`).

## 6. Theme switching — atomic, tracked, weakly held

### 6.1 Bookkeeping

```ts
const current = { theme: DEFAULT_THEME }; // theme.ts:53
const varPairs = new WeakMap<
  Theme,
  Map<WeakRef<Entity>, Map<string, unknown>>
>(); // theme.ts:70
const entityRefs = new WeakMap<Entity, WeakRef<Entity>>(); // theme.ts:75
```

`varPairs` keys by `Theme` (a dropped theme is collected wholesale via `WeakMap`), values map `WeakRef<Entity>` → `Map<string, unknown>` of tracked style _keys_ to the `var()` expression they reference — not the whole style object (`theme.ts:59`). Multiple `var()` styles on one entity accumulate; a later literal on the same key replaces the reference instead of being clobbered on the next switch (`theme.ts:61`, `packages/styles/test/v2.test.ts:181`).

Entities are held through `WeakRef`s, not strongly (`theme.ts:70`): `Entity.destroy()` has no hook back into styles (`theme.ts:65`), so a strong inner map retained every styled entity for the lifetime of its theme and `setTheme` kept re-resolving destroyed ones (#644, `packages/styles/test/issue-644.test.ts:49`). Dead refs are swept during the walk; `untrackVarStyles(entity)` (`theme.ts:160`) is the eager path for frameworks that know when an entity is gone — idempotent, safe for never-tracked entities (`issue-644.test.ts:93`).

`entityRefs: WeakMap<Entity, WeakRef<Entity>>` (`theme.ts:75`) gives a stable `WeakRef` per entity (`theme.ts:77` `refOf`) so repeated styles on one entity hit the same tracking entry instead of orphaning unreachable duplicates. The ref object itself is weakly held and dies with the entity.

`trackVarKeys(entity, style)` (`theme.ts:175`) is called by `applyStyle` with the _original_ style `s` (not the resolved one) so literal-override semantics are preserved (`apply.ts:300`):

- `typeof value === 'string' && HAS_VAR_RE.test(value)` → `keys.set(key, value)` (`theme.ts:181`) — anchored or embedded `var()` both track.
- `padding` object with `HAS_VAR_RE` on either axis → track the whole key (`theme.ts:185`).
- Otherwise → `keys.delete(key)` (`theme.ts:195`) — the literal is written by the caller and must not be replayed. `keys.size === 0` prunes the entity entry (`theme.ts:197`).

### 6.2 `setTheme(next)` — dry-run, then commit

```ts
export function setTheme(next: Theme): void {
  if (next === current.theme) return; // theme.ts:117 — identity, not deep equal
  const previous = current.theme;
  const pairs = varPairs.get(previous);
  const resolved = new Map<WeakRef<Entity>, Style>();
  if (pairs) {
    for (const [ref, keys] of pairs) {
      const entity = ref.deref();
      if (entity === undefined) {
        pairs.delete(ref);
        continue;
      } // sweep collected (#644) theme.ts:129
      const style: Style = {};
      for (const [key, expr] of keys)
        (style as Record<string, unknown>)[key] = expr;
      resolved.set(ref, resolveStyle(style, next).style); // dry-run against next — throws while still on previous
    }
  }
  current.theme = next; // theme.ts:139 — only after every dry-run succeeded
  if (pairs) {
    const nextPairs = pairsOf(next);
    for (const [ref, style] of resolved) {
      const entity = ref.deref();
      if (entity === undefined) continue; // collected between the passes theme.ts:144
      applyStyleResolved(entity, style); // no re-tracking — already migrated below
      nextPairs.set(ref, pairs.get(ref)!); // migrate refs onto next theme theme.ts:146
    }
    varPairs.delete(previous); // theme.ts:148
  }
}
```

The atomicity guarantee (`theme.ts:107`): every tracked style is resolved against `next` _before_ `current.theme` moves. A missing token or an invalid value (e.g. `--gap: '50%'` at `v2.test.ts:126`, `--radius-md` missing at `v2.test.ts:139` GH-485) throws while the scene, the active theme, and the pair bookkeeping are all still fully consistent under the previous theme — never half-restyled. Verified by the GH-485 test: a `partial` theme missing `radius-md` throws, `getTheme() === themeA` still holds, neither entity was restyled, and a subsequent valid switch still re-resolves every pair (`v2.test.ts:137`).

`getTheme(): Theme` (`theme.ts:96`) reads `current.theme`; `untrackVarStyles` (`theme.ts:160`) drops the entity's entry under the active theme so the next `setTheme` stops replaying it.

## 7. Font composition and per-axis padding — the two non-trivial writes

### 7.1 `composeFont` — surgery on a shorthand string

UI components carry the whole font as one `font: string` (`packages/ui/src/UIComponent.ts:1` via `Entity`, `packages/ui/src/Text.ts:111` `font: string`). The three CSS-named keys are not independent fields — `applyStyleResolved` parses the current shorthand, replaces the segments the style changes, and writes the recomposed string (`apply.ts:207` `FONT_KEYS` loop, `apply.ts:267` `composeFont(current, fontChanges)`).

`composeFont(current, changes)` (`packages/styles/src/font.ts:113`) delegates to `parse(font)` (`font.ts:73`) which tokenizes on whitespace (`font.ts:74` `split(/\s+/).filter(Boolean)`), consumes leading `style`/`variant`/`weight` keywords (`font.ts:40` `parsePrefixes` with `WEIGHT_RE = /^(normal|bold|bolder|lighter|[1-9]00)$/` at `font.ts:18`, `STYLE_RE` `:19`, `VARIANT_RE` `:20`), matches `SIZE_SLOT_RE = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:rem|em|px|pt))(?:\/([^\s/]+))?$/` (`font.ts:26`) at the size slot, and treats the remainder as `family`. Recomposition joins `[style, variant, weight, size[/lineHeight], family]` (`font.ts:103`).

Why this matters:

- Prefix grammar: `italic 700 16px Georgia` or `16px/24px Inter` used to collapse everything around the size into the family (`font.ts:14`), so a later segment change recomposed an invalid string that Canvas2D silently drops. Now `fontSize: '20px'` on `italic 700 16px Georgia` yields `italic 700 20px Georgia` (`issue-608.test.ts:107`) and preserves `16px/24px` line-height (`issue-608.test.ts:112`).
- `normal` ambiguity: `font: normal normal 16px Inter` is valid CSS; the first `normal` fills `weight`, further ones fill `style` then `variant` (`font.ts:48`) instead of falling into the size slot and throwing.
- Loud failures: `ultra-condensed 700 16px serif` before the size throws naming the offending segment (`issue-608.test.ts:124`). Size-like segments that cannot be placed fail at `font.ts:91` (`unrecognized segment '…' before the font size`) rather than being buried in the family.
- Missing size/family defaults: `parts.size ??= '16px'` and `family ??= 'sans-serif'` (`font.ts:121`) so an empty `font: ''` plus `fontFamily: 'Inter'` yields `'16px Inter'` (`v2.test.ts:239`), and bare style-prefix shorthands `italic Georgia` normalize to `italic 18px Georgia` (`issue-608.test.ts:129`).
- Runtime unit enforcement: `fontSize` arriving as `12` (bare number from a token) throws `unit-bearing token (e.g. '16px')` (`apply.ts:223`), `'2em'` throws `fontSize expects a px string` (`apply.ts:233`), and a `fontFamily` containing a digit triggers `looks like a font shorthand` (`apply.ts:214`, `v2.test.ts:272`). The `fontSize:`${number}px`` type (`types.ts:46`) catches the static case; the runtime catches tokens and JS callers.

### 7.2 Per-axis padding — `padding: { x, y }`

`padding?: CssLength | { x?: CssLength; y?: CssLength }` (`types.ts:34`). Box components (`Button`, `Link`, `Card`) carry `padding` (uniform) plus `paddingX`/`paddingY` (`packages/ui/src/UIComponent.ts:21` / `:28`): the apply layer writes the per-axis fields when present (`apply.ts:248` `paddingX`/`paddingY` via `isCssLength(v, 'padding.x')`), leaves `padding` untouched, and reports `applied: ['padding']` as a whole. On entities without per-axis fields the style is skipped (`v2.test.ts:329`) — construction-time `padding` in the component's options still governs intrinsic sizing; post-construction `padding: {x,y}` is read live by consumers that inspect `paddingX`/`paddingY` (e.g. `Card` layout), not by re-measuring the box.

Token references inside the object resolve per axis (`apply.ts:168` `resolveValue(pad.x, theme)`), and `trackVarKeys` tracks the key as a whole when either axis references a token (`theme.ts:189`). An invalid axis value throws naming `padding.x` (`v2.test.ts:336`).

## 8. How UI and core consume it

No UI component imports `@vectojs/styles` at runtime — styles are applied _to_ them, not _by_ them. The components expose typed numeric fields that happen to be the Rule table's write targets:

- **Geometry** — every `Entity` has `x/y/width/height/opacity/scaleX/scaleY/rotation` — `Text` and `Button` build on them directly.
- **Box** — `UIComponent` (`packages/ui/src/UIComponent.ts:19`) owns `padding`, `paddingX`, `paddingY`; `Button` (`packages/ui/src/Button.ts:19`) owns `bg` (`backgroundColor` → `bg` at `apply.ts:63`), `color`, `borderColor`, `radius` (`borderRadius`), plus `font` for its label centering (`Button.ts:80` `measureText(label, font)`). `Card`, `Link`, `Tabs` follow the same box fields.
- **Text** — `Text` (`packages/ui/src/Text.ts:18` `TextOptions`) owns `font`, `color`, `lineHeight`, `textAlign` (`'left'|'justify'` — `Text.ts:42`); its `fontSize` is extracted via `fontSizePx(font)` (`packages/ui/src/measure.ts:27`) which scans for the `px` token by `indexOf('px')` rather than a regex with adjacent digit-class quantifiers (same ReDoS hygiene as `font.ts:26` `SIZE_SLOT_RE`). `familyOf(font)` (`measure.ts:57`) decomposes the same shorthand for per-family measurement.
- **Layout** — `Stack` (`packages/ui/src/Stack.ts:10`) owns `direction→flexDirection`, `gap`, `align→alignItems`, `wrap→flexWrap`; `Flow` is the sibling container. Only these two accept the container-only keys — any other entity throws (`packages/styles/test/styles.test.ts:144`).

Core text entities (`packages/core/src/text/MSDFTextEntity.ts:1` `MSDFTextEntity`, `SVGEntity`) are not styled through this package in the current codebase — their `font`/`maxWidth`/`lineHeight` are driven by `MSDFFont` and `LayoutWorkerManager` (boss 02). Applying `fontSize: '20px'` to an `MSDFTextEntity` would still hit `composeFont` but there is no `applyStyle` call site for it today; the chapter's text interaction is at the measurement contract level (measure where you paint, `packages/text/src/measureContext.ts:87` `getSharedMeasuringContext`).

`measure.ts` also owns the font-metrics invalidation that styles interact with indirectly: webfont loads fire `notifyFontMetricsChanged` (`measure.ts:111`) which clears the LRU and notifies `UIComponent.watchFontMetrics(handler)` (`UIComponent.ts:128`) subscribers — `Text` and `Button` re-measure their intrinsic widths and `markDirty`. Styles do not need to be re-applied after a webfont load; the entities' own `watchFontMetrics` handlers keep geometry correct.

## 9. Migrating from CSS habits onto the VMT — every silent failure made loud

The package's doctrine (GH-608, `packages/styles/src/theme.ts:20` "GH-608 doctrine") is that an unrecognized `var()` form must never pass through silently — the one thing this package must not do is hand Canvas2D a string it silently ignores. That doctrine extends to every CSS habit that has no VMT counterpart:

| CSS habit                                                                    | What happens                                                                                                                                      | Why                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `width: '50%'`, `gap: '8em'`, `radius: '50%'`                                | `TypeError: width expects a bare number or a px string` (`apply.ts:29`)                                                                           | Only px units exist on the VMT; `%`/`em`/`rem` have no backing field (see `vectojs-docs/content/reference/styles.md:193`). Percentage gaps would require a containing block that VMT never computes.                                                                                         |
| `textAlign: 'center' \| 'right'`                                             | `TypeError: textAlign expects one of left \| justify` (`apply.ts:50`, `styles.test.ts:87`)                                                        | `Text`/`RichText`/`TextEntity` and the layout engine (`LayoutEngine.textAlign` at `packages/layout/src/LayoutEngine.ts:1`) implement `left` and `justify` only — `center`/`right` cannot be honored and must not render as `left` silently (`vectojs-docs/content/reference/styles.md:208`). |
| `var(--token, fallback)`                                                     | `TypeError: var() fallbacks are not supported — 'var(--accent, #fff)' would reach the entity field unresolved` (`apply.ts:149`)                   | Fallback resolution is not implemented; the raw string would reach Canvas2D which silently keeps the previous paint, and the key would go untracked for `setTheme` (#645, `issue-645.test.ts:33`).                                                                                           |
| `rotation: '30deg'` or naked `30`                                            | Written as a number only (`isFiniteNumber` at `apply.ts:33`) and interpreted as **radians** (`types.ts:25`). `rotate(30deg)` must be `Math.PI/6`. | Every other VectoJS rotation surface is radians; the style layer does not introduce a second unit.                                                                                                                                                                                           |
| `display: 'block'`, `flexDirection: 'row-reverse'`                           | `TypeError: display expects one of flex` (`apply.ts:50`, `styles.test.ts:152`)                                                                    | Only `flex` containers exist; `block`/`grid` have no meaning for a `Stack`/`Flow` that _already is_ flex.                                                                                                                                                                                    |
| `gap` / `alignItems` on a `Text`                                             | `TypeError: 'gap' is a container-only property and Text is not a container` (`apply.ts:189`, `styles.test.ts:144`)                                | Category error, not a silent no-op.                                                                                                                                                                                                                                                          |
| `position: 'absolute'`, `transform`, `justifyContent`, `border: '1px solid'` | `unknown style property 'position'` (`apply.ts:258`, `styles.test.ts:159`)                                                                        | No field to write; adding them would reintroduce cascade/margin-collapse machinery the VMT exists to remove (`vectojs-docs/content/reference/styles.md:198`).                                                                                                                                |
| `fontSize: 16` (bare number) or `fontSize: '2em'`                            | `bare number` / `expects a px string like '16px'` (`apply.ts:223` / `:233`)                                                                       | Canvas font shorthands require a unit-bearing size; a bare number composes an invalid shorthand Canvas2D silently drops (`v2.test.ts:244`, `issue-608.test.ts:137`).                                                                                                                         |
| `fontFamily: '16px Inter'`                                                   | `looks like a font shorthand — reference the 'font' token` (`apply.ts:214`, `v2.test.ts:272`)                                                     | Prevents a full shorthand leaking into the family slot and discarding size/weight.                                                                                                                                                                                                           |

The common thread: every throw names the CSS property and echoes the value (`apply.ts:29` `JSON.stringify(value)`), so a grep for the message finds the migrating call site. A style that _passes_ validation always produces a valid canvas font shorthand and a number the VMT can paint — there is no path where a bad value silently paints the previous frame's state.

## 10. Hard parts — with receipts

| Pitfall                                                                                             | Where                                                        | Status                                                                                                     |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `rgba(var(--rgb), 0.4)` written as the raw string — Canvas2D silently kept the old fill             | `apply.ts:133` (GH-608), `issue-608.test.ts:37`              | Fixed: embedded `var()` substituted via `VAR_REPLACE_RE` (`apply.ts:105`)                                  |
| `italic 700 16px` size prefix collapsed into family on recompose                                    | `font.ts:14` (GH-608)                                        | Fixed: full `[style\|variant\|weight]? size[/line-height]? family` parser (`font.ts:40` `parsePrefixes`)   |
| `16px/24px` line-height segment lost on `fontSize` change                                           | `font.ts:26` `SIZE_SLOT_RE`                                  | Fixed: `size/lineHeight` capture and re-emit (`font.ts:80` / `:102`)                                       |
| `fontSize` accepting `'2em'`/`2rem` and composing a shorthand Canvas2D drops                        | `apply.ts:232` (GH-608)                                      | Fixed: runtime `px` enforcement (`apply.ts:232`, `issue-608.test.ts:137`)                                  |
| `css()` sharing the same `padding: {x,y}` object between variants                                   | `css.ts:23` (GH-608)                                         | Fixed: per-axis copy (`css.ts:23`, `issue-608.test.ts:153`)                                                |
| `var(--token, fallback)` passing through unresolved                                                 | `theme.ts:24` `HAS_VAR_FALLBACK_RE` (#645)                   | Fixed: detected before embedded substitution and thrown (`apply.ts:147`, `issue-645.test.ts:30`)           |
| `var( --token, fb)` with a stray space escaping the fallback guard                                  | `theme.ts:24` `/var\(\s*--/` (#753)                          | Fixed: whitespace after `var(` allowed (`issue-645.test.ts:78`)                                            |
| Token-ref→token chains leaking the literal `var(--…)` into string fields                            | `apply.ts:112` `resolveToken` (GH-452/608)                   | Fixed: transitive `resolveValue` with `seen` cycle set (`apply.ts:125`)                                    |
| `setTheme` half-restyling on a missing token                                                        | `theme.ts:107` dry-run (GH-485, `v2.test.ts:137`)            | Fixed: resolve-all-before-commit, `current.theme` only moves after every dry-run                           |
| Styled entities retained forever — `WeakMap<Theme, Map<Entity,…>>` held strongly                    | `theme.ts:70` `WeakRef` (#644)                               | Fixed: `WeakMap<Theme, Map<WeakRef<Entity>,…>>` + `refOf` (`theme.ts:77`) + sweep on walk (`theme.ts:129`) |
| `css()` sharing the same `padding` object while `var()` tracking key is deleted on literal override | `theme.ts:195` `keys.delete(key)` (GH-451, `v2.test.ts:181`) | Fixed: per-key `Map<string,unknown>` rather than per-object tracking                                       |
| `fontSize` bare-number token `bad-size: 12` composing `'700 12 Inter'` silently                     | `apply.ts:221` bare-number guard                             | Fixed: `fontSize resolved to the bare number 12 — use a unit-bearing token` (`v2.test.ts:244`)             |
| `SIZE_SLOT_RE` polynomial ReDoS on `\d+\.?\d*` adjacent digit classes                               | `font.ts:26` branch-safe `SIZE_SLOT_RE` (`v2.test.ts:258`)   | Fixed: no adjacent same-class quantifiers, longer unit alternatives first (`font.ts:22`)                   |
| `Text` hardcoded `textAlign: 'center'` from a migrated stylesheet                                   | `styles.test.ts:87`                                          | By design: throws — `center`/`right` have no entity backing; migrate to `left`+layout or `justify`         |

## 11. Checklist — before you land a styles change

1. **Never alias the nested shape.** A `Style` carries at most one nested object (`padding: {x,y}` at `types.ts:34`); `css()` must copy it (`css.ts:23`) and any new nested key needs the same treatment or variant merges bleed.
2. **Enforce units at runtime, not just in types.** `` fontSize: `${number}px` `` (`types.ts:46`) catches `16` at compile time, but tokens and JS callers bypass it — `apply.ts:221` / `232` must still throw.
3. **Keep token resolution atomic.** `setTheme`'s dry-run (`theme.ts:124` `resolveStyle(style, next)`) must cover every tracked key before `current.theme` moves; a value that fails validation on switch must not half-restyling the scene (`v2.test.ts:137` GH-485).
4. **Hold entities weakly.** `varPairs` must stay `WeakMap<Theme, Map<WeakRef<Entity>,…>>` (`theme.ts:70`) and sweep `ref.deref() === undefined` (`theme.ts:129`) — `Entity.destroy()` cannot call `untrackVarStyles` because `core` has no dep on `styles` (`theme.ts:65`).
5. **Track per key, not per object.** `trackVarKeys` (`theme.ts:175`) compares the _current_ style's keys against the stored `Map<string,unknown>` — a later literal on the same key must `delete` it (`theme.ts:195`) or the var replay clobbers it (`v2.test.ts:181` GH-451).
6. **Keep the font parser and the `isCssLength` guard in sync.** `SIZE_SLOT_RE` (`font.ts:26`) and `isCssLength` (`apply.ts:23`) share the same `px`-string shape; diverging lets one accept what the other rejects and composes an invalid shorthand Canvas2D silently drops.
7. **Fail loudly on unknown forms.** Any new `var()` syntax, new CSS key, or new container-only property must throw with the property name and value (`apply.ts:29` `JSON.stringify(value)`) — the GH-608 doctrine that silence is the one thing this package must not do with an unrecognized form.

---

_Series: 00 Overview → 01 Selection → 02 Text+Layout → 03 Projection+Virtualization → 04 Streaming Markdown → 05 TeX → 06 VMT Runtime → 07 Renderer → 08 WASM G1/G2/G3 → 09 Three/XR → 10 Video Export → 11 Graph Layout → 12 DevTools → **13 Styles & Theming** → 99 Synthesis._
